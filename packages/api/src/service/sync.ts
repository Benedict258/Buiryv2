import {
  PgWriteQueue,
  WriteWorker,
  type WalrusMemoryAdapter,
  type WorkerOptions,
  type WriteJob,
  type WriteQueue,
} from '@buiry/storage';
import type { ServiceDeps } from './types.js';
import { genId } from './util.js';
import { onRenewalStored } from './renewal.js';
import { raiseFlag } from './ops.js';

/** A queue whose every call runs in its own system transaction (workers have no tenant context). */
export function systemQueue(deps: ServiceDeps): WriteQueue {
  return new PgWriteQueue({ query: (q, p) => deps.db.system((tx) => tx.query(q, p)) });
}

/** Maps a completed Walrus write back onto the memory and its event. */
export async function onJobStored(deps: ServiceDeps, job: WriteJob, blobId: string): Promise<void> {
  if (!job.ref) return;
  await deps.db.system(async (tx) => {
    const ev = await tx.query<{ memory_id: string; type: string; workspace_id: string; project_id: string }>(
      'update memory_events set walrus_blob_id = $1 where id = $2 returning memory_id, type, workspace_id, project_id',
      [blobId, job.ref],
    );
    const e = ev.rows[0];
    if (e?.type === 'memory.renewed') return onRenewalStored(deps, tx, e, blobId, job.relayerJobId);
    if (e && (e.type === 'memory.created' || e.type === 'handoff.created')) {
      await tx.query(
        `update memories set walrus_blob_id = $1, walrus_job_id = $2, write_state = 'stored' where id = $3`,
        [blobId, job.relayerJobId, e.memory_id],
      );
    }
  });
}

/**
 * Shown to a project after 2 consecutive failed writes, whatever the relayer's /health says (Phase 10 F5: live, health
 * said "ok" for hours while every job failed). Cleared on the next stored write. Content-free.
 */
export const WRITE_FAILURES_NOTICE =
  "Writes to this project's Walrus storage keep failing though the relayer reports healthy. New memories stay queued and are retried later.";
const WRITE_FAILURE_THRESHOLD = 2;

async function setWriteFailureNotice(deps: ServiceDeps, projectId: string, on: boolean): Promise<void> {
  await deps.db.system(async (tx) => {
    if (!on) {
      await tx.query(
        `update flags set state = 'resolved', resolved_at = $1 where project_id = $2 and kind = 'write_failures' and state <> 'resolved'`,
        [new Date(deps.now()), projectId],
      );
      return;
    }
    const p = await tx.query<{ workspace_id: string }>('select workspace_id from projects where id = $1', [
      projectId,
    ]);
    if (!p.rows[0]) return;
    await raiseFlag(deps, tx, {
      workspaceId: p.rows[0].workspace_id,
      projectId,
      kind: 'write_failures',
      severity: 'warning',
      detail: WRITE_FAILURES_NOTICE,
    });
  });
}

/** A write that exhausted its retries: mark the memory failed and raise a flag. */
export async function onJobDead(deps: ServiceDeps, job: WriteJob, error: string): Promise<void> {
  if (!job.ref) return;
  await deps.db.system(async (tx) => {
    const ev = await tx.query<{ memory_id: string; type: string; workspace_id: string }>(
      'select memory_id, type, workspace_id from memory_events where id = $1',
      [job.ref],
    );
    const e = ev.rows[0];
    if (!e) return;
    if (e.type === 'memory.created' || e.type === 'handoff.created') {
      await tx.query(`update memories set write_state = 'failed' where id = $1`, [e.memory_id]);
    }
    await tx.query(
      `insert into flags (id, workspace_id, project_id, memory_id, kind, severity, detail, group_key, first_seen, last_seen)
       values ($1,$2,$3,$4,'failed_write','critical',$5,$6,$7,$7)`,
      [
        genId(deps, 'flg'),
        e.workspace_id,
        job.projectId,
        e.memory_id,
        `Write failed after retries: ${error.slice(0, 200)}`,
        `failed_write:${e.memory_id}`,
        new Date(deps.now()),
      ],
    );
  });
}

export function createDrain(
  deps: ServiceDeps,
  adapter: WalrusMemoryAdapter,
  o: Partial<WorkerOptions> & { workerId?: string } = {},
): WriteWorker {
  // Consecutive failed attempts per project, for the F5 notice. In memory: a restart starts the count again, while an
  // open notice stays until a write is stored.
  const failures = new Map<string, number>();
  return new WriteWorker({
    queue: systemQueue(deps),
    adapter,
    workerId: o.workerId ?? 'worker-1',
    now: deps.now,
    onStored: async (j, b) => {
      await onJobStored(deps, j, b);
      failures.delete(j.projectId);
      await setWriteFailureNotice(deps, j.projectId, false);
    },
    onAttemptFailed: async (j) => {
      const n = (failures.get(j.projectId) ?? 0) + 1;
      failures.set(j.projectId, n);
      if (n >= WRITE_FAILURE_THRESHOLD) await setWriteFailureNotice(deps, j.projectId, true);
    },
    onDead: (j, e) => onJobDead(deps, j, e),
    // Relayer job ids and status changes, content-free, into the structured event log (Phase 10).
    ...(deps.eventLog ? { log: deps.eventLog } : {}),
    ...o,
  });
}
