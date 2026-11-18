import { BuiryError, newId, errorTag } from '@buiry/core';
import { PgWriteQueue, type Renewer } from '@buiry/storage';
import type { Tx } from '../db/db.js';
import { publishEvent } from './events.js';
import { assertAllowed, loadProject } from './ops.js';
import type { Principal, ServiceDeps } from './types.js';
import { actorOf, genId, logActivity } from './util.js';

/**
 * Renewal by rewrite. Walrus Memory exposes no way to extend a stored blob (A1), so a memory close to expiry is
 * written again: the exact stored text, under the original idempotency key with a generation suffix (`.r1`, `.r2`,
 * ...), so a repeated scan queues it once. The memory keeps pointing at its old blob until the new one is stored;
 * then `memory.renewed` is recorded and the old blob id is kept as `previous_blob_id` (the old blob stays on Walrus
 * until it lapses). The rewrite goes through the normal write queue, so it is drained by the project's own account.
 */

export interface RenewalOutcome {
  /** Memories with a rewrite queued (or already queued for this generation). */
  queued: string[];
  /** Memories that could not be renewed, with the reason. */
  failed: { memoryId: string; reason: string }[];
}

interface Source {
  memory_id: string;
  workspace_id: string;
  project_id: string;
  renewal_generation: number;
  walrus_blob_id: string;
  namespace: string;
  agent_id: string;
  text: string;
  idempotency_key: string;
}

/** Queues a rewrite for one stored memory in the caller's transaction. */
async function queueOne(deps: ServiceDeps, tx: Tx, memoryId: string): Promise<string | null> {
  const r = await tx.query<Source>(
    `select m.id as memory_id, m.workspace_id, m.project_id, m.renewal_generation, m.walrus_blob_id,
            j.namespace, j.agent_id, j.text, j.idempotency_key
       from memories m
       join write_jobs j on j.memory_id = m.id and j.blob_id = m.walrus_blob_id and j.state = 'stored'
      where m.id = $1 and m.expired = false and m.write_state = 'stored'
      order by j.updated_at desc limit 1`,
    [memoryId],
  );
  const s = r.rows[0];
  if (!s) return 'not stored, already expired, or its stored text is not available';
  const generation = s.renewal_generation + 1;
  const key = `${s.idempotency_key.replace(/\.r\d+$/, '')}.r${generation}`;
  const existing = await tx.query('select 1 from write_jobs where idempotency_key = $1', [key]);
  if (existing.rows.length) return null; // already queued for this generation
  const now = deps.now();
  const eventId = genId(deps, 'evt');
  await tx.query(
    `insert into memory_events (id, workspace_id, memory_id, project_id, tier, type, payload, actor_kind, actor_id, seq, created_at)
     values ($1,$2,$3,$4,'A','memory.renewed',$5,'system','renewal',0,$6)`,
    [
      eventId,
      s.workspace_id,
      s.memory_id,
      s.project_id,
      JSON.stringify({ previousBlobId: s.walrus_blob_id, generation, state: 'queued' }),
      new Date(now),
    ],
  );
  await new PgWriteQueue(tx).enqueue({
    id: newId('job', now, deps.random),
    memoryId: s.memory_id,
    idempotencyKey: key,
    namespace: s.namespace,
    projectId: s.project_id,
    agentId: s.agent_id,
    text: s.text,
    ref: eventId,
    at: now,
  });
  return null;
}

/** Queues rewrites for the given memories (system context: the worker's expiry scan). */
export async function queueRenewals(deps: ServiceDeps, memoryIds: string[]): Promise<RenewalOutcome> {
  const out: RenewalOutcome = { queued: [], failed: [] };
  for (const id of memoryIds) {
    // Sweep A5: Buiry's own reasons as they are; anything else becomes a stable message, logged by class and code.
    const why = await deps.db
      .system((tx) => queueOne(deps, tx, id))
      .catch((e: unknown) => {
        if (e instanceof BuiryError) return e.message;
        console.error(JSON.stringify({ level: 'error', event: 'renewal_error', ...errorTag(e) }));
        return 'internal error';
      });
    if (why) out.failed.push({ memoryId: id, reason: why });
    else out.queued.push(id);
  }
  return out;
}

/** The expiry scan's renewer: maps expiring blob ids to their memories and queues rewrites. */
export function rewriteRenewer(deps: ServiceDeps): Renewer {
  return {
    async renew(blobIds) {
      if (!blobIds.length) return { renewed: [], failed: [] };
      const rows = await deps.db.system(
        async (tx) =>
          (
            await tx.query<{ id: string; walrus_blob_id: string }>(
              'select id, walrus_blob_id from memories where walrus_blob_id = any($1)',
              [blobIds],
            )
          ).rows,
      );
      const res = await queueRenewals(
        deps,
        rows.map((r) => r.id),
      );
      const renewed = rows.filter((r) => res.queued.includes(r.id)).map((r) => r.walrus_blob_id);
      return { renewed, failed: blobIds.filter((b) => !renewed.includes(b)) };
    },
  };
}

/** Renewal requested from the dashboard for memories of one project (writers and above). */
export async function renewMemories(
  deps: ServiceDeps,
  tx: Tx,
  p: Principal,
  projectId: string,
  memoryIds: string[],
): Promise<RenewalOutcome> {
  if (!deps.renewalEnabled)
    throw new BuiryError('invalid_input', 'renewal is turned off on this deployment (BUIRY_RENEWAL)');
  await loadProject(tx, p, projectId);
  assertAllowed(p, 'write');
  const own = await tx.query<{ id: string }>(
    'select id from memories where project_id = $1 and id = any($2)',
    [projectId, memoryIds],
  );
  const ids = new Set(own.rows.map((r) => r.id));
  const out: RenewalOutcome = { queued: [], failed: [] };
  for (const id of memoryIds) {
    if (!ids.has(id)) {
      out.failed.push({ memoryId: id, reason: 'not in this project' });
      continue;
    }
    const why = await queueOne(deps, tx, id);
    if (why) out.failed.push({ memoryId: id, reason: why });
    else out.queued.push(id);
  }
  await logActivity(tx, deps, {
    workspaceId: p.workspaceId,
    projectId,
    actor: actorOf(p),
    operation: 'memory.renew',
    target: { queued: out.queued.length, failed: out.failed.length },
    result: out.queued.length ? 'queued' : 'error',
  });
  return out;
}

/** Called when a renewal rewrite is stored: switch the memory to the new blob and record the event. */
export async function onRenewalStored(
  deps: ServiceDeps,
  tx: Tx,
  e: { memory_id: string; workspace_id: string; project_id: string },
  blobId: string,
  relayerJobId: string | null,
): Promise<void> {
  const r = await tx.query<{ previous_blob_id: string | null; renewal_generation: number }>(
    `update memories set previous_blob_id = walrus_blob_id, walrus_blob_id = $1, walrus_job_id = $2,
            renewal_generation = renewal_generation + 1, end_epoch = null, expires_at = null, expired = false
      where id = $3 and walrus_blob_id is distinct from $1
      returning previous_blob_id, renewal_generation`,
    [blobId, relayerJobId, e.memory_id],
  );
  const row = r.rows[0];
  if (!row) return;
  // The warning is about the old blob; the next expiry scan reads the new one's expiry.
  await tx.query(
    `update flags set state = 'resolved', resolved_at = $1 where memory_id = $2 and kind = 'expiring' and state <> 'resolved'`,
    [new Date(deps.now()), e.memory_id],
  );
  await publishEvent(deps, tx, {
    workspaceId: e.workspace_id,
    projectId: e.project_id,
    type: 'memory.renewed',
    data: {
      memoryId: e.memory_id,
      blobId,
      previousBlobId: row.previous_blob_id,
      generation: row.renewal_generation,
    },
  });
}
