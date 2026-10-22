import {
  BuiryError,
  DEFAULT_LEARNING,
  ONBOARDING_BUDGET,
  buildBriefing,
  deriveNamespace,
  findConflictCandidates,
  surfaceFailures,
  tokens,
  type BranchInfo,
  type BranchInput,
  type BranchOutput,
  type CheckInput,
  type CheckOutput,
  type ConnectInput,
  type ConnectOutput,
  type FlagItem,
  type MemoryDetail,
  type RecallInput,
  type RecallOutput,
  type StatusOutput,
} from '@buiry/core';
import {
  PgWriteQueue,
  RecallService,
  RelayerError,
  type IndexedMemory,
  type MemoryIndex,
  type WalrusMemoryAdapter,
} from '@buiry/storage';
import type { Tx } from '../db/db.js';
import { createBranchRow } from './admin.js';
import { activeBranch, assertAllowed, loadBranch, loadMemoryRow, loadProject } from './ops.js';
import type { AgentPrincipal, Principal, ServiceDeps } from './types.js';
import { actorOf, evidenceFor, iso, loadMemories, logActivity, type MemoryRow } from './util.js';

// ---------- index over Postgres (the rebuildable cache of Walrus) ----------

export class PgMemoryIndex implements MemoryIndex {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly workspaceId: string,
  ) {}

  async getMany(ids: string[]): Promise<IndexedMemory[]> {
    if (ids.length === 0) return [];
    return this.deps.db.tenant(this.workspaceId, async (tx) => {
      const r = await tx.query<MemoryRow>('select * from memories where id = any($1)', [ids]);
      return loadMemories(tx, r.rows);
    });
  }

  async searchLocal(q: {
    projectId: string;
    branches: string[];
    query: string;
    limit: number;
  }): Promise<IndexedMemory[]> {
    return this.deps.db.tenant(this.workspaceId, async (tx) => {
      const terms = [...tokens(q.query)].filter((t) => /^[\p{L}\p{N}]+$/u.test(t)).slice(0, 12);
      const params: unknown[] = [q.projectId, q.branches, q.limit];
      let sql = `select * from memories where project_id = $1 and branch_slug = any($2) and expired = false and status not in ('superseded','tombstoned')`;
      if (terms.length) {
        params.push(terms.join(' | '));
        sql += ` order by (tsv @@ to_tsquery('simple', $4)) desc, ts_rank(tsv, to_tsquery('simple', $4)) desc, updated_at desc`;
      } else sql += ' order by updated_at desc';
      sql += ' limit $3';
      const r = await tx.query<MemoryRow>(sql, params);
      return loadMemories(tx, r.rows);
    });
  }
}

class OfflineAdapter implements Pick<WalrusMemoryAdapter, 'recall'> {
  async recall(): Promise<never> {
    throw new RelayerError('unavailable', 'no relayer configured');
  }
}

export async function recallOp(
  deps: ServiceDeps,
  p: Principal,
  projectId: string,
  i: RecallInput,
): Promise<RecallOutput> {
  const t0 = deps.now();
  const slug: string =
    i.branch ??
    (p.kind === 'agent' ? await deps.db.tenant(p.workspaceId, (tx) => activeBranch(tx, p)) : 'main');
  await deps.db.tenant(p.workspaceId, async (tx) => {
    await loadProject(tx, p, projectId);
    await loadBranch(tx, projectId, slug);
    assertAllowed(p, 'read');
  });
  if (!i.query?.trim()) throw new BuiryError('invalid_input', 'query is required');
  const svc = new RecallService(
    (deps.adapter ?? new OfflineAdapter()) as WalrusMemoryAdapter,
    new PgMemoryIndex(deps, p.workspaceId),
    deps.learning ?? DEFAULT_LEARNING,
  );
  const out = await svc.recall({
    projectId,
    branch: slug,
    query: i.query,
    ...(i.type ? { type: i.type } : {}),
    ...(i.status ? { status: i.status } : {}),
    limit: i.limit ?? 10,
    now: deps.now(),
  });
  await deps.db.tenant(p.workspaceId, async (tx) => {
    for (const r of out.results) {
      await tx.query(
        `insert into memory_events (id, workspace_id, memory_id, project_id, tier, type, payload, actor_kind, actor_id, seq, created_at)
         values ($1,$2,$3,$4,'B','memory.recalled',$5,$6,$7,0,$8)`,
        [
          `evt_${Buffer.from(deps.random(10)).toString('hex')}`,
          p.workspaceId,
          r.memoryId,
          projectId,
          JSON.stringify({ query: i.query.slice(0, 120) }),
          p.kind === 'agent' ? 'agent' : 'user',
          p.kind === 'agent' ? p.agentSlug : p.userId,
          new Date(deps.now()),
        ],
      );
    }
    await logActivity(tx, deps, {
      workspaceId: p.workspaceId,
      projectId,
      actor: actorOf(p),
      operation: 'recall',
      target: { query: i.query.slice(0, 120), branch: slug, memoryIds: out.results.map((r) => r.memoryId) },
      result: 'success',
      latencyMs: deps.now() - t0,
      detail: { servedFromCache: out.servedFromCache, count: out.results.length },
    });
  });
  return {
    results: out.results.map((r) => ({ ...r, writeState: r.writeState })),
    servedFromCache: out.servedFromCache,
    mayHaveMore: out.mayHaveMore,
  };
}

// ---------- connect ----------

export async function countsFor(tx: Tx, projectId: string): Promise<ConnectOutput['counts']> {
  const r = await tx.query<{ status: string; n: string | number }>(
    `select status, count(*) as n from memories where project_id = $1 group by status`,
    [projectId],
  );
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of r.rows) {
    byStatus[row.status] = Number(row.n);
    total += Number(row.n);
  }
  return { total, byStatus };
}

export async function connectTx(
  deps: ServiceDeps,
  tx: Tx,
  p: AgentPrincipal,
  i: ConnectInput,
): Promise<ConnectOutput> {
  const t0 = deps.now();
  if (i.project && i.project !== p.projectId) {
    throw new BuiryError(
      'forbidden',
      'BUIRY.md names a different project than the one this agent token belongs to',
    );
  }
  const project = await loadProject(tx, p, p.projectId);
  const agent = await tx.query<{ first_connected_at: Date | null; active_branch: string }>(
    'select first_connected_at, active_branch from agents where id = $1',
    [p.agentId],
  );
  const first = !agent.rows[0]?.first_connected_at;
  let branch = agent.rows[0]?.active_branch ?? 'main';
  if (i.branch) {
    const b = await loadBranch(tx, p.projectId, i.branch);
    assertAllowed(p, 'read', b);
    branch = b.slug;
  }
  await tx.query(
    `update agents set last_seen_at = $1, first_connected_at = coalesce(first_connected_at, $1), active_branch = $2, client_version = coalesce($3, client_version) where id = $4`,
    [new Date(deps.now()), branch, i.client ?? null, p.agentId],
  );
  const counts = await countsFor(tx, p.projectId);
  const last = await tx.query<{ agent_slug: string; created_at: Date }>(
    `select agent_slug, created_at from memories where project_id = $1 and agent_slug <> $2 order by created_at desc limit 1`,
    [p.projectId, p.agentSlug],
  );
  const lastAny =
    last.rows[0] ??
    (
      await tx.query<{ agent_slug: string; created_at: Date }>(
        `select agent_slug, created_at from memories where project_id = $1 order by created_at desc limit 1`,
        [p.projectId],
      )
    ).rows[0];
  await logActivity(tx, deps, {
    workspaceId: p.workspaceId,
    projectId: p.projectId,
    actor: actorOf(p),
    operation: 'connect',
    target: { branch, client: i.client ?? null, firstConnection: first },
    result: 'success',
    latencyMs: deps.now() - t0,
  });
  return {
    project: { id: project.id, name: project.name, networks: project.networks },
    branch,
    counts,
    ...(lastAny
      ? { lastActivity: { agent: lastAny.agent_slug, at: new Date(lastAny.created_at).toISOString() } }
      : {}),
    firstConnection: first,
    agent: { slug: p.agentSlug, permissions: p.permissions },
  };
}

// ---------- check / briefing ----------

export async function briefingTx(
  deps: ServiceDeps,
  tx: Tx,
  p: Principal,
  projectId: string,
  i: CheckInput & { onboardingOverride?: boolean },
  slug: string,
): Promise<CheckOutput & { items: { memoryId: string; section: string }[] }> {
  const project = await loadProject(tx, p, projectId);
  assertAllowed(p, 'read');
  const branches = slug === 'main' ? ['main'] : [slug, 'main'];
  const rows = await tx.query<MemoryRow>(
    `select * from memories where project_id = $1 and branch_slug = any($2) and status not in ('superseded','tombstoned') and expired = false order by updated_at desc limit 500`,
    [projectId, branches],
  );
  const memories = await loadMemories(tx, rows.rows);

  let onboarding = i.onboardingOverride ?? false;
  let sinceMs = 0;
  if (p.kind === 'agent') {
    const a = await tx.query<{ first_check_at: Date | null; last_check_at: Date | null }>(
      'select first_check_at, last_check_at from agents where id = $1',
      [p.agentId],
    );
    onboarding = onboarding || (!a.rows[0]?.first_check_at && memories.length > 0);
    sinceMs = a.rows[0]?.last_check_at ? new Date(a.rows[0].last_check_at).getTime() : 0;
  }
  const counts = await countsFor(tx, projectId);
  const last = await tx.query<{ agent_slug: string; created_at: Date }>(
    `select agent_slug, created_at from memories where project_id = $1 order by created_at desc limit 1`,
    [projectId],
  );

  const extraFlags: { memoryId?: string; kind: string; detail: string }[] = [];
  const flagItems: FlagItem[] = [];
  const open = await tx.query<{ memory_id: string | null; kind: string; detail: string }>(
    `select memory_id, kind, detail from flags where project_id = $1 and state <> 'resolved' and kind in ('expiring','failed_write','relayer','verification') order by severity, last_seen desc limit 20`,
    [projectId],
  );
  for (const f of open.rows) {
    extraFlags.push({ ...(f.memory_id ? { memoryId: f.memory_id } : {}), kind: f.kind, detail: f.detail });
    if ((f.kind === 'expiring' || f.kind === 'failed_write') && f.memory_id)
      flagItems.push({ memoryId: f.memory_id, kind: f.kind, detail: f.detail });
  }
  const failed = await tx.query<{ id: string }>(
    `select id from memories where project_id = $1 and write_state = 'failed' limit 10`,
    [projectId],
  );
  for (const f of failed.rows)
    flagItems.push({
      memoryId: f.id,
      kind: 'failed_write',
      detail: 'This memory could not be stored on Walrus after retries',
    });
  for (const m of memories) {
    if (m.status === 'stale')
      flagItems.push({ memoryId: m.id, kind: 'stale', detail: 'Evidence no longer matches current state' });
    if (m.status === 'contested')
      flagItems.push({
        memoryId: m.id,
        kind: 'contested',
        detail: 'Conflicts with another memory or was reported wrong',
      });
  }

  const b = buildBriefing({
    now: deps.now(),
    memories,
    ...(i.task ? { task: i.task } : {}),
    ...(i.tokenBudget ? { tokenBudget: Math.min(8000, Math.max(200, i.tokenBudget)) } : {}),
    onboarding,
    project: { name: project.name, networks: project.networks },
    counts,
    ...(last.rows[0]
      ? { lastWriter: { agent: last.rows[0].agent_slug, at: new Date(last.rows[0].created_at).getTime() } }
      : {}),
    extraFlags,
    cfg: deps.learning ?? DEFAULT_LEARNING,
  });

  const ne = await tx.query<{ n: string | number }>(
    `select count(*) as n from memory_events where project_id = $1 and tier = 'A' and created_at > $2 and coalesce(actor_id,'') <> $3`,
    [projectId, new Date(sinceMs), p.kind === 'agent' ? p.agentSlug : p.userId],
  );
  return {
    briefing: b.markdown,
    flags: flagItems,
    newEvents: Number(ne.rows[0]?.n ?? 0),
    generatedAt: new Date(deps.now()).toISOString(),
    onboarding,
    tokensUsed: b.tokensUsed,
    items: b.items.map((x) => ({ memoryId: x.memoryId, section: x.section })),
  };
}

export async function checkTx(
  deps: ServiceDeps,
  tx: Tx,
  p: AgentPrincipal,
  i: CheckInput,
): Promise<CheckOutput> {
  const t0 = deps.now();
  const slug =
    i.branch ??
    (await tx.query<{ active_branch: string }>('select active_branch from agents where id = $1', [p.agentId]))
      .rows[0]?.active_branch ??
    'main';
  await loadBranch(tx, p.projectId, slug);
  const out = await briefingTx(deps, tx, p, p.projectId, i, slug);
  await tx.query(
    `update agents set last_check_at = $1, first_check_at = coalesce(first_check_at, $1), last_seen_at = $1 where id = $2`,
    [new Date(deps.now()), p.agentId],
  );
  await logActivity(tx, deps, {
    workspaceId: p.workspaceId,
    projectId: p.projectId,
    actor: actorOf(p),
    operation: 'check',
    target: { branch: slug, task: i.task?.slice(0, 120) ?? null, budget: i.tokenBudget ?? null },
    result: 'success',
    latencyMs: deps.now() - t0,
    // Briefings are recorded as references to memory ids, not full text (replay, section 12).
    detail: {
      memoryIds: out.items.map((x) => x.memoryId),
      onboarding: out.onboarding,
      tokensUsed: out.tokensUsed,
    },
  });
  const { items: _items, ...rest } = out;
  void _items;
  return rest;
}

/** Failures that resemble the current task are flagged to the agent at check time (FR-L4). */
export async function failuresForTask(
  tx: Tx,
  projectId: string,
  slug: string,
  task: string,
): Promise<string[]> {
  const rows = await tx.query<MemoryRow>(
    `select * from memories where project_id = $1 and branch_slug = any($2) and type = 'failure' and status not in ('superseded','tombstoned') and expired = false limit 200`,
    [projectId, slug === 'main' ? ['main'] : [slug, 'main']],
  );
  return surfaceFailures(
    task,
    rows.rows.map((r) => ({ id: r.id, text: r.text, type: r.type, status: r.status })),
  ).map((x) => x.memory.id);
}

// ---------- get memory ----------

export async function getMemoryTx(
  deps: ServiceDeps,
  tx: Tx,
  p: Principal,
  projectId: string,
  memoryId: string,
): Promise<MemoryDetail> {
  await loadProject(tx, p, projectId);
  assertAllowed(p, 'read');
  const row = await loadMemoryRow(tx, projectId, memoryId);
  const ev = (await evidenceFor(tx, [row.id])).get(row.id) ?? [];
  const rec = (await loadMemories(tx, [row]))[0]!;
  return {
    memoryId: row.id,
    text: row.text,
    type: row.type,
    status: row.status,
    confidence: rec.confidence,
    branch: row.branch_slug,
    agent: row.agent_slug,
    evidence: ev,
    ...(row.supersedes_id ? { supersedes: row.supersedes_id } : {}),
    ...(row.superseded_by_id ? { supersededBy: row.superseded_by_id } : {}),
    ...(row.walrus_blob_id ? { walrusBlobId: row.walrus_blob_id } : {}),
    writeState: row.write_state,
    ...(row.expires_at ? { expiresAt: iso(new Date(row.expires_at).getTime())! } : {}),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

// ---------- branches ----------

export async function branchOp(
  deps: ServiceDeps,
  tx: Tx,
  p: Principal,
  projectId: string,
  i: BranchInput,
): Promise<BranchOutput> {
  const project = await loadProject(tx, p, projectId);
  const activeSlug =
    p.kind === 'agent'
      ? ((
          await tx.query<{ active_branch: string }>('select active_branch from agents where id = $1', [
            p.agentId,
          ])
        ).rows[0]?.active_branch ?? 'main')
      : 'main';
  const list = async (active: string): Promise<BranchInfo[]> => {
    const r = await tx.query<{ slug: string; protected: boolean; parent: string | null; n: string | number }>(
      `select b.slug, b.protected, pb.slug as parent,
              (select count(*) from memories m where m.branch_id = b.id and m.status not in ('superseded','tombstoned')) as n
         from branches b left join branches pb on pb.id = b.parent_branch_id where b.project_id = $1 and b.archived_at is null order by b.created_at`,
      [projectId],
    );
    return r.rows.map((x) => ({
      slug: x.slug,
      protected: x.protected,
      ...(x.parent ? { parent: x.parent } : {}),
      memoryCount: Number(x.n),
      active: x.slug === active,
    }));
  };
  const t0 = deps.now();
  let active = activeSlug;
  let proposal: BranchOutput['proposal'];
  switch (i.action) {
    case 'list':
      assertAllowed(p, 'read');
      break;
    case 'create': {
      assertAllowed(p, 'write');
      await createBranchRow(deps, tx, {
        workspaceId: p.workspaceId,
        projectId,
        slug: i.name,
        parentSlug: i.from ?? 'main',
        createdBy: p.kind === 'agent' ? p.agentSlug : p.userId,
      });
      break;
    }
    case 'switch': {
      assertAllowed(p, 'read');
      const b = await loadBranch(tx, projectId, i.name);
      if (p.kind === 'agent') {
        if (p.branchScope && b.slug !== p.branchScope && b.slug !== 'main')
          throw new BuiryError('forbidden', `this agent is limited to branch "${p.branchScope}"`);
        await tx.query('update agents set active_branch = $1 where id = $2', [b.slug, p.agentId]);
      }
      active = b.slug;
      break;
    }
    case 'propose_merge': {
      assertAllowed(p, 'read');
      const src = await loadBranch(tx, projectId, i.name);
      const target = await loadBranch(tx, projectId, i.into ?? 'main');
      const cand = await tx.query<MemoryRow>(
        `select * from memories where project_id = $1 and branch_id = $2 and status = 'confirmed' and expired = false
           and not exists (select 1 from memories t where t.branch_id = $3 and t.ref_memory_id = memories.id)`,
        [projectId, src.id, target.id],
      );
      const tgt = await tx.query<MemoryRow>(
        `select * from memories where project_id = $1 and branch_id = $2 and status not in ('superseded','tombstoned')`,
        [projectId, target.id],
      );
      proposal = {
        source: src.slug,
        target: target.slug,
        candidates: cand.rows.map((m) => ({
          memoryId: m.id,
          text: m.text,
          conflictWith: findConflictCandidates(
            { text: m.text, type: m.type },
            tgt.rows.map((r) => ({ id: r.id, text: r.text, type: r.type, status: r.status })),
          ).map((c) => ({ memoryId: c.memoryId, similarity: c.similarity })),
        })),
      };
      break;
    }
  }
  await logActivity(tx, deps, {
    workspaceId: p.workspaceId,
    projectId: project.id,
    actor: actorOf(p),
    operation: 'branch',
    target: { action: i.action, ...('name' in i ? { name: i.name } : {}) },
    result: 'success',
    latencyMs: deps.now() - t0,
  });
  return { branches: await list(active), active, ...(proposal ? { proposal } : {}) };
}

// ---------- status ----------

export async function statusOp(deps: ServiceDeps, p: Principal, projectId: string): Promise<StatusOutput> {
  const scoped = await deps.db.tenant(p.workspaceId, async (tx) => {
    const project = await loadProject(tx, p, projectId);
    assertAllowed(p, 'read');
    const total = await tx.query<{ n: string | number }>(
      'select count(*) as n from memories where project_id = $1',
      [project.id],
    );
    const exp = await tx.query<{ expiring: string | number; expired: string | number; soonest: Date | null }>(
      `select count(*) filter (where expired = false and expires_at is not null and expires_at < $2) as expiring,
              count(*) filter (where expired) as expired, min(expires_at) filter (where expired = false) as soonest
         from memories where project_id = $1`,
      [project.id, new Date(deps.now() + 28 * 86_400_000)],
    );
    return { total: Number(total.rows[0]?.n ?? 0), exp: exp.rows[0]! };
  });
  const sys = await deps.db.system(async (tx) => {
    const r = await tx.query<{ state: string; n: string | number; oldest: string | number | null }>(
      `select state, count(*) as n, min(created_at) as oldest from write_jobs where project_id = $1 group by state`,
      [projectId],
    );
    const relayer = await tx.query<{ reachable: boolean; write_state: string; version: string | null }>(
      `select reachable, write_state, version from relayer_status order by checked_at desc limit 1`,
    );
    return { jobs: r.rows, relayer: relayer.rows[0] };
  });
  const queue = { queued: 0, submitting: 0, submitted: 0, stored: 0, dead: 0, oldestPendingAgeMs: 0 };
  for (const j of sys.jobs) {
    if (j.state in queue) (queue as Record<string, number>)[j.state] = Number(j.n);
    if (['queued', 'submitting', 'submitted'].includes(j.state) && j.oldest !== null)
      queue.oldestPendingAgeMs = Math.max(queue.oldestPendingAgeMs, deps.now() - Number(j.oldest));
  }
  const gw = deps.gateway?.status();
  return {
    queue,
    relayer: sys.relayer
      ? {
          state: !sys.relayer.reachable
            ? 'unreachable'
            : (sys.relayer.write_state as 'ok' | 'degraded' | 'paused'),
          ...(sys.relayer.version ? { version: sys.relayer.version } : {}),
        }
      : { state: 'unknown' },
    gateway: gw
      ? { state: gw.state, transportMix: gw.transportMix, latencyP95: gw.latencyP95 }
      : { state: 'unconfigured' },
    expiry: {
      expiring: Number(scoped.exp.expiring),
      expired: Number(scoped.exp.expired),
      ...(scoped.exp.soonest ? { soonest: new Date(scoped.exp.soonest).toISOString() } : {}),
    },
    project: { id: projectId, memories: scoped.total },
  };
}

export { deriveNamespace, ONBOARDING_BUDGET, PgWriteQueue };
