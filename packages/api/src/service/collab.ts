import { BuiryError, findConflictCandidates, type Evidence } from '@buiry/core';
import type { Tx } from '../db/db.js';
import { publishEvent } from './events.js';
import {
  assertAllowed,
  createMemoryTx,
  emitDurable,
  humanSlug,
  loadBranch,
  loadMemoryRow,
  loadProject,
} from './ops.js';
import type { Principal, ServiceDeps } from './types.js';
import { actorOf, evidenceFor, genId, logActivity, notFound, type MemoryRow } from './util.js';

// ---------- merge ----------

export type MergeResolution =
  { kind: 'supersede'; targetMemoryId: string } | { kind: 'distinct' } | { kind: 'skip' };

export interface MergeInput {
  source: string;
  target: string;
  items: { memoryId: string; resolution?: MergeResolution }[];
  closeSource?: boolean;
}

export interface MergeOutput {
  mergeId: string;
  written: { sourceId: string; newId: string }[];
  superseded: string[];
  skipped: string[];
}

export interface MergeConflict {
  memoryId: string;
  conflictsWith: { memoryId: string; similarity: number; text: string }[];
}

/**
 * Merging copies by writing new events, never by moving data: each selected memory becomes a new
 * `created` event in the target branch with `ref=<source id>`, plus `superseded` events for replaced
 * target memories, and one `branch.merged` event. Protected targets need an admin.
 */
export async function mergeBranchTx(
  deps: ServiceDeps,
  tx: Tx,
  p: Principal,
  projectId: string,
  m: MergeInput,
): Promise<MergeOutput> {
  const t0 = deps.now();
  const project = await loadProject(tx, p, projectId);
  const src = await loadBranch(tx, projectId, m.source);
  const tgt = await loadBranch(tx, projectId, m.target);
  if (src.id === tgt.id) throw new BuiryError('invalid_input', 'source and target are the same branch');
  assertAllowed(p, 'merge', tgt);
  if (!m.items.length) throw new BuiryError('invalid_input', 'select at least one memory to merge');

  const targetPool = await tx.query<MemoryRow>(
    `select * from memories where project_id = $1 and branch_id = $2 and status not in ('superseded','tombstoned') and expired = false`,
    [projectId, tgt.id],
  );
  const prepared: { row: MemoryRow; evidence: Evidence[]; resolution?: MergeResolution }[] = [];
  const conflicts: MergeConflict[] = [];
  for (const item of m.items) {
    const row = await loadMemoryRow(tx, projectId, item.memoryId, true);
    if (row.branch_id !== src.id)
      throw new BuiryError('invalid_input', `memory ${row.id} is not on branch ${m.source}`);
    if (row.status === 'superseded' || row.status === 'tombstoned')
      throw new BuiryError('invalid_input', `memory ${row.id} is ${row.status}`);
    const evidence = (await evidenceFor(tx, [row.id])).get(row.id) ?? [];
    if (targetPool.rows.some((t) => t.ref_memory_id === row.id)) {
      // Already merged into the target: nothing to resolve, nothing to write.
      prepared.push({ row, evidence, resolution: { kind: 'skip' } });
      continue;
    }
    if (!item.resolution) {
      const c = findConflictCandidates(
        { text: row.text, type: row.type },
        targetPool.rows.map((r) => ({ id: r.id, text: r.text, type: r.type, status: r.status })),
        deps.learning,
      );
      if (c.length) conflicts.push({ memoryId: row.id, conflictsWith: c });
    }
    prepared.push({ row, evidence, ...(item.resolution ? { resolution: item.resolution } : {}) });
  }
  if (conflicts.length) {
    throw new BuiryError(
      'conflict',
      `${conflicts.length} memories conflict with the target; resolve each as supersede, distinct or skip`,
      undefined,
      { conflicts: conflicts as unknown as Record<string, unknown>[] } as never,
    );
  }

  const out: MergeOutput = { mergeId: genId(deps, 'evt'), written: [], superseded: [], skipped: [] };
  for (const { row, evidence, resolution } of prepared) {
    if (resolution?.kind === 'skip') {
      out.skipped.push(row.id);
      continue;
    }
    const already = await tx.query('select 1 from memories where branch_id = $1 and ref_memory_id = $2', [
      tgt.id,
      row.id,
    ]);
    if (already.rows.length) {
      out.skipped.push(row.id);
      continue;
    }
    const created = await createMemoryTx(
      deps,
      tx,
      p,
      projectId,
      {
        text: row.text,
        type: row.type,
        branch: tgt.slug,
        evidence,
        ...(resolution?.kind === 'supersede'
          ? { relation: { kind: 'supersedes' as const, memoryId: resolution.targetMemoryId } }
          : {}),
        idempotencyKey: `merge:${row.id}:${tgt.id}`,
      },
      { confirmed: p.kind === 'user', skipConflicts: true, mergedFrom: row.id },
    );
    // A merged memory keeps the trust it earned on the branch.
    await tx.query(
      'update memories set confidence = greatest(confidence, $1), last_reinforced_at = $2 where id = $3',
      [row.confidence, new Date(deps.now()), created.memoryId],
    );
    out.written.push({ sourceId: row.id, newId: created.memoryId });
    if (resolution?.kind === 'supersede') out.superseded.push(resolution.targetMemoryId);
  }
  await tx.query(
    `insert into branch_merges (id, workspace_id, project_id, source_branch_id, target_branch_id, merged_by, summary) values ($1,$2,$3,$4,$5,$6,$7)`,
    [
      out.mergeId,
      p.workspaceId,
      projectId,
      src.id,
      tgt.id,
      humanSlug(p),
      JSON.stringify({ written: out.written, superseded: out.superseded, skipped: out.skipped }),
    ],
  );
  await emitDurable(deps, tx, {
    p,
    project,
    branch: tgt,
    memoryId: out.mergeId,
    evt: 'branch.merged',
    body: `Merged ${out.written.length} memories from ${src.slug} into ${tgt.slug}; ${out.superseded.length} superseded, ${out.skipped.length} skipped.`,
    seq: 1,
    force: true,
    payload: { source: src.slug, target: tgt.slug, written: out.written.length },
  });
  if (m.closeSource)
    await tx.query('update branches set merged_at = $1 where id = $2', [new Date(deps.now()), src.id]);
  await publishEvent(deps, tx, {
    workspaceId: p.workspaceId,
    projectId,
    type: 'branch.merged',
    data: {
      source: src.slug,
      target: tgt.slug,
      written: out.written.length,
      detail: `${out.written.length} memories merged into ${tgt.slug}`,
    },
  });
  await logActivity(tx, deps, {
    workspaceId: p.workspaceId,
    projectId,
    actor: actorOf(p),
    operation: 'branch.merge',
    target: { source: src.slug, target: tgt.slug, mergeId: out.mergeId },
    result: 'success',
    latencyMs: deps.now() - t0,
    detail: { written: out.written.length, superseded: out.superseded.length, skipped: out.skipped.length },
  });
  return out;
}

// ---------- flags / alerts ----------

export interface FlagRow {
  id: string;
  memory_id: string | null;
  kind: string;
  severity: string;
  state: string;
  detail: string;
  first_seen: Date;
  last_seen: Date;
}

export async function listFlags(tx: Tx, p: Principal, projectId: string, state?: string): Promise<FlagRow[]> {
  await loadProject(tx, p, projectId);
  assertAllowed(p, 'read');
  const r = await tx.query<FlagRow>(
    `select id, memory_id, kind, severity, state, detail, first_seen, last_seen from flags where project_id = $1 and ($2::text is null or state = $2)
     order by case severity when 'critical' then 0 when 'warning' then 1 else 2 end, last_seen desc limit 200`,
    [projectId, state ?? null],
  );
  return r.rows;
}

export async function setFlagState(
  deps: ServiceDeps,
  tx: Tx,
  p: Principal,
  projectId: string,
  flagId: string,
  state: 'acknowledged' | 'resolved',
): Promise<void> {
  await loadProject(tx, p, projectId);
  assertAllowed(p, 'write');
  const r = await tx.query<{ kind: string; memory_id: string | null }>(
    `update flags set state = $1, acknowledged_by = case when $1 = 'acknowledged' then $2 else acknowledged_by end,
       resolved_at = case when $1 = 'resolved' then $3 else resolved_at end where id = $4 and project_id = $5 returning kind, memory_id`,
    [state, humanSlug(p), new Date(deps.now()), flagId, projectId],
  );
  if (!r.rows[0]) throw notFound('flag');
  if (state === 'resolved') {
    await publishEvent(deps, tx, {
      workspaceId: p.workspaceId,
      projectId,
      type: 'flag.resolved',
      data: {
        flagId,
        kind: r.rows[0].kind,
        ...(r.rows[0].memory_id ? { memoryId: r.rows[0].memory_id } : {}),
      },
    });
  }
  await logActivity(tx, deps, {
    workspaceId: p.workspaceId,
    projectId,
    actor: actorOf(p),
    operation: `flag.${state}`,
    target: { flagId },
    result: 'success',
  });
}

// ---------- handoffs ----------

export async function listHandoffs(
  tx: Tx,
  p: Principal,
  projectId: string,
  opts: { branch?: string; limit?: number } = {},
) {
  await loadProject(tx, p, projectId);
  assertAllowed(p, 'read');
  const r = await tx.query<{
    id: string;
    branch_slug: string;
    memory_id: string;
    agent_slug: string;
    done: string[];
    blocked: string[];
    next: string[];
    relied_on: string[];
    notes: string | null;
    created_at: Date;
  }>(
    `select id, branch_slug, memory_id, agent_slug, done, blocked, next, relied_on, notes, created_at from handoffs
      where project_id = $1 and ($2::text is null or branch_slug = $2) order by created_at desc limit $3`,
    [projectId, opts.branch ?? null, opts.limit ?? 50],
  );
  return r.rows;
}

// ---------- replay ----------

const EVENT_STATUS: Record<string, string> = {
  'memory.confirmed': 'confirmed',
  'memory.contested': 'contested',
  'memory.stale': 'stale',
  'memory.superseded': 'superseded',
  'memory.tombstoned': 'tombstoned',
};

export interface ReplayOutput {
  at: string;
  counts: { total: number; byStatus: Record<string, number> };
  memories: {
    id: string;
    type: string;
    status: string;
    branch: string;
    text: string;
    changedSince: boolean;
  }[];
  /** Tier A events up to `at`, newest first. */
  events: { id: string; memoryId: string; type: string; actor: string | null; at: string }[];
  briefingsShown: {
    agent: string | null;
    at: string;
    memories: { id: string; statusThen: string | null }[];
  }[];
  note: string;
}

/**
 * Project state at time T: replays tier A events (exact) and lists the briefings delivered by then.
 * Tier B signals are available only for the period the database retains them.
 */
export async function replayAt(tx: Tx, p: Principal, projectId: string, atMs: number): Promise<ReplayOutput> {
  await loadProject(tx, p, projectId);
  assertAllowed(p, 'read');
  const at = new Date(atMs);
  const ev = await tx.query<{
    id: string;
    memory_id: string;
    type: string;
    payload: { status?: string };
    actor_id: string | null;
    created_at: Date;
    seq: number;
  }>(
    `select id, memory_id, type, payload, actor_id, created_at, seq from memory_events where project_id = $1 and tier = 'A' and created_at <= $2 order by created_at, seq`,
    [projectId, at],
  );
  const state = new Map<string, string>();
  for (const e of ev.rows) {
    if (e.type === 'memory.created' || e.type === 'handoff.created')
      state.set(e.memory_id, e.payload.status ?? 'proposed');
    else if (EVENT_STATUS[e.type] && state.has(e.memory_id)) state.set(e.memory_id, EVENT_STATUS[e.type]!);
  }
  const ids = [...state.keys()];
  const rows = ids.length
    ? await tx.query<MemoryRow>('select * from memories where id = any($1)', [ids])
    : { rows: [] as MemoryRow[] };
  const now = await tx.query<{ id: string; status: string }>(
    'select id, status from memories where id = any($1)',
    [ids],
  );
  const nowStatus = new Map(now.rows.map((r) => [r.id, r.status]));
  const byStatus: Record<string, number> = {};
  for (const s of state.values()) byStatus[s] = (byStatus[s] ?? 0) + 1;
  const shown = await tx.query<{
    actor_id: string | null;
    created_at: Date;
    detail: { memoryIds?: string[] };
  }>(
    `select actor_id, created_at, detail from activity_log where project_id = $1 and operation = 'check' and created_at <= $2 order by created_at desc limit 50`,
    [projectId, at],
  );
  return {
    at: at.toISOString(),
    counts: { total: state.size, byStatus },
    memories: rows.rows.map((r) => ({
      id: r.id,
      type: r.type,
      status: state.get(r.id)!,
      branch: r.branch_slug,
      text: r.text,
      changedSince: nowStatus.get(r.id) !== state.get(r.id),
    })),
    events: [...ev.rows]
      .reverse()
      .slice(0, 200)
      .map((e) => ({
        id: e.id,
        memoryId: e.memory_id,
        type: e.type,
        actor: e.actor_id,
        at: new Date(e.created_at).toISOString(),
      })),
    briefingsShown: shown.rows.map((s) => ({
      agent: s.actor_id,
      at: new Date(s.created_at).toISOString(),
      memories: (s.detail.memoryIds ?? []).map((id) => ({ id, statusThen: state.get(id) ?? null })),
    })),
    note: 'Tier A events are replayed exactly; reports and validations are local signals kept only while the database retains them.',
  };
}
