import { createHash, randomBytes } from 'node:crypto';
import {
  BuiryError,
  MEMORY_TYPES,
  STATUSES,
  decodeMemory,
  effectiveConfidence,
  encodeMemory,
  generateBuiryMd,
  redact,
  scanInjection,
  type Evidence,
  type MemoryType,
  type Status,
} from '@buiry/core';
import type { Tx } from '../db/db.js';
import { createAgent, issueAgentToken, revokeAgent } from './admin.js';
import { assertManage } from './members.js';
import { assertProjectNetworks } from './networks.js';
import { assertAllowed, createMemoryTx, loadMemoryRow, loadProject } from './ops.js';
import { checkEntitlement, PLANS, usageFor, type PlanName } from './plans.js';
import type { Principal, ServiceDeps, UserPrincipal } from './types.js';
import {
  actorOf,
  evidenceFor,
  genId,
  hmac,
  learningFor,
  loadMemories,
  logActivity,
  notFound,
  type MemoryRow,
} from './util.js';

// ---------- projects ----------

export async function listProjects(tx: Tx, p: UserPrincipal) {
  const r = await tx.query<{
    id: string;
    name: string;
    networks: string[];
    walrus_mode: string;
    created_at: Date;
    archived_at: Date | null;
    memories: string;
    open_flags: string;
    agents: string;
    last_activity: Date | null;
    expiring: string;
  }>(
    `select pr.id, pr.name, pr.networks, pr.walrus_mode, pr.created_at, pr.archived_at,
            (select count(*) from memories m where m.project_id = pr.id) as memories,
            (select count(*) from flags f where f.project_id = pr.id and f.state <> 'resolved') as open_flags,
            (select count(*) from agents a where a.project_id = pr.id and a.revoked_at is null) as agents,
            (select max(created_at) from activity_log l where l.project_id = pr.id) as last_activity,
            (select count(*) from flags f where f.project_id = pr.id and f.kind = 'expiring' and f.state <> 'resolved') as expiring
       from projects pr order by pr.created_at`,
  );
  return r.rows
    .filter((x) => !p.projectScope || p.projectScope.includes(x.id))
    .map((x) => ({
      id: x.id,
      name: x.name,
      networks: x.networks,
      walrusMode: x.walrus_mode,
      createdAt: x.created_at,
      archivedAt: x.archived_at,
      memories: Number(x.memories),
      openFlags: Number(x.open_flags),
      agents: Number(x.agents),
      lastActivity: x.last_activity,
      expiring: Number(x.expiring),
    }));
}

export async function projectOverview(tx: Tx, p: Principal, projectId: string, now: number) {
  const pr = await loadProject(tx, p, projectId);
  assertAllowed(p, 'read');
  const byType = await tx.query<{ type: string; status: string; n: string }>(
    'select type, status, count(*) as n from memories where project_id = $1 group by type, status',
    [projectId],
  );
  const flags = await tx.query<{ kind: string; severity: string; n: string }>(
    `select kind, severity, count(*) as n from flags where project_id = $1 and state <> 'resolved' group by kind, severity`,
    [projectId],
  );
  const agents = await tx.query<{
    slug: string;
    tool: string;
    last_seen_at: Date | null;
    revoked_at: Date | null;
  }>(
    'select slug, tool, last_seen_at, revoked_at from agents where project_id = $1 order by last_seen_at desc nulls last',
    [projectId],
  );
  const soonest = await tx.query<{ expires_at: Date | null }>(
    'select min(expires_at) as expires_at from memories where project_id = $1 and expired = false and expires_at is not null',
    [projectId],
  );
  const queue = await tx.query<{ state: string; n: string }>(
    'select state, count(*) as n from write_jobs where project_id = $1 group by state',
    [projectId],
  );
  return {
    project: { id: pr.id, name: pr.name, networks: pr.networks, accountId: pr.walrus_account_id },
    byTypeAndStatus: byType.rows.map((r) => ({ type: r.type, status: r.status, count: Number(r.n) })),
    openFlags: flags.rows.map((r) => ({ kind: r.kind, severity: r.severity, count: Number(r.n) })),
    agents: agents.rows.map((a) => ({
      slug: a.slug,
      tool: a.tool,
      lastSeenAt: a.last_seen_at,
      revoked: !!a.revoked_at,
      activeLast24h: !!a.last_seen_at && now - new Date(a.last_seen_at).getTime() < 86_400_000,
    })),
    soonestExpiry: soonest.rows[0]?.expires_at ?? null,
    queue: Object.fromEntries(queue.rows.map((r) => [r.state, Number(r.n)])),
  };
}

export async function createProjectChecked(
  deps: ServiceDeps,
  tx: Tx,
  p: Principal,
  input: {
    name: string;
    description?: string;
    networks?: string[];
    walrusMode?: 'managed' | 'byo' | 'self_hosted';
    repoFingerprint?: string;
  },
  enforce = true,
): Promise<{ id: string }> {
  assertManage(p);
  if (!input.name?.trim()) throw new BuiryError('invalid_input', 'project name is required');
  assertProjectNetworks(deps, input.networks);
  await checkEntitlement(tx, p.workspaceId, 'projects', enforce);
  const id = genId(deps, 'prj');
  const main = genId(deps, 'brn');
  await tx.query(
    `insert into projects (id, workspace_id, name, description, networks, walrus_mode, repo_fingerprint, settings) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id,
      p.workspaceId,
      input.name.trim(),
      input.description ?? null,
      input.networks ?? [],
      input.walrusMode ?? 'managed',
      input.repoFingerprint ?? null,
      JSON.stringify({ allowProposedOnMain: true, driftScanIntervalHours: 6, expiryMarginEpochs: 2 }),
    ],
  );
  await tx.query(
    `insert into branches (id, workspace_id, project_id, slug, namespace, protected, created_by) values ($1,$2,$3,'main',$4,true,$5)`,
    [main, p.workspaceId, id, `buiry.v1.${id}.main`, p.userId],
  );
  await logActivity(tx, deps, {
    workspaceId: p.workspaceId,
    projectId: id,
    actor: actorOf(p),
    operation: 'project.create',
    target: { projectId: id },
    result: 'success',
  });
  return { id };
}

const SETTINGS_KEYS = [
  'allowProposedOnMain',
  'driftScanIntervalHours',
  'expiryMarginEpochs',
  'autoPromotion',
  'redaction',
  'halfLives',
  'reviewThreshold',
  'defaultTokenBudget',
  'publicShowcase',
] as const;

export async function updateProject(
  deps: ServiceDeps,
  tx: Tx,
  p: Principal,
  projectId: string,
  patch: { name?: string; description?: string; networks?: string[]; settings?: Record<string, unknown> },
) {
  assertManage(p);
  await loadProject(tx, p, projectId);
  if (patch.networks !== undefined) assertProjectNetworks(deps, patch.networks);
  if (patch.name !== undefined && !patch.name.trim())
    throw new BuiryError('invalid_input', 'project name cannot be empty');
  const settings: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch.settings ?? {})) {
    if (!(SETTINGS_KEYS as readonly string[]).includes(k))
      throw new BuiryError('invalid_input', `unknown setting "${k}"`);
    settings[k] = v;
  }
  await tx.query(
    `update projects set name = coalesce($1, name), description = coalesce($2, description), networks = coalesce($3, networks), settings = settings || $4::jsonb where id = $5`,
    [
      patch.name?.trim() ?? null,
      patch.description ?? null,
      patch.networks ?? null,
      JSON.stringify(settings),
      projectId,
    ],
  );
  await logActivity(tx, deps, {
    workspaceId: p.workspaceId,
    projectId,
    actor: actorOf(p),
    operation: 'project.update',
    target: { projectId },
    result: 'success',
  });
}

export async function archiveProject(deps: ServiceDeps, tx: Tx, p: Principal, projectId: string) {
  assertManage(p);
  await loadProject(tx, p, projectId);
  await tx.query('update projects set archived_at = $1 where id = $2', [new Date(deps.now()), projectId]);
  await tx.query('update agents set revoked_at = coalesce(revoked_at, $1) where project_id = $2', [
    new Date(deps.now()),
    projectId,
  ]);
  await tx.query(
    'update agent_tokens set revoked_at = coalesce(revoked_at, $1) where agent_id in (select id from agents where project_id = $2)',
    [new Date(deps.now()), projectId],
  );
  await tx.query(
    `insert into audit_log (id, workspace_id, actor, action, target) values ($1,$2,$3,'project.archive',$4)`,
    [genId(deps, 'evt'), p.workspaceId, (p as UserPrincipal).userId, projectId],
  );
}

// ---------- memories ----------

export interface MemoryFilter {
  q?: string;
  type?: MemoryType[];
  status?: Status[];
  branch?: string;
  agent?: string;
  minConfidence?: number;
  maxConfidence?: number;
  evidence?: 'any' | 'none' | 'verified' | 'failed';
  expiring?: boolean;
  flagged?: boolean;
  createdAfter?: string;
  sort?: 'updated' | 'created' | 'confidence' | 'expiry';
  cursor?: string;
  limit?: number;
}

export async function listMemories(
  deps: ServiceDeps,
  tx: Tx,
  p: Principal,
  projectId: string,
  f: MemoryFilter,
) {
  const project = await loadProject(tx, p, projectId);
  const cfg = learningFor(deps, project.settings);
  assertAllowed(p, 'read');
  const w: string[] = ['m.project_id = $1'];
  const args: unknown[] = [projectId];
  const add = (sql: string, v: unknown) => {
    args.push(v);
    w.push(sql.replace('?', `$${args.length}`));
  };
  if (f.type?.length)
    add(
      'm.type = any(?)',
      f.type.filter((t) => (MEMORY_TYPES as readonly string[]).includes(t)),
    );
  if (f.status?.length)
    add(
      'm.status = any(?)',
      f.status.filter((s) => (STATUSES as readonly string[]).includes(s)),
    );
  if (f.branch) add('m.branch_slug = ?', f.branch);
  if (f.agent) add('m.agent_slug = ?', f.agent);
  if (f.minConfidence !== undefined) add('m.confidence >= ?', f.minConfidence);
  if (f.maxConfidence !== undefined) add('m.confidence <= ?', f.maxConfidence);
  if (f.createdAfter) add('m.created_at >= ?', new Date(f.createdAfter));
  if (f.expiring)
    add(
      '(m.expired = false and m.expires_at is not null and m.expires_at < ?)',
      new Date(deps.now() + 28 * 86_400_000),
    );
  if (f.flagged)
    w.push(`exists (select 1 from flags fl where fl.memory_id = m.id and fl.state <> 'resolved')`);
  if (f.evidence === 'none') w.push('not exists (select 1 from evidence e where e.memory_id = m.id)');
  if (f.evidence === 'any') w.push('exists (select 1 from evidence e where e.memory_id = m.id)');
  if (f.evidence === 'verified')
    w.push(`exists (select 1 from evidence e where e.memory_id = m.id and e.last_result = 'pass')`);
  if (f.evidence === 'failed')
    w.push(`exists (select 1 from evidence e where e.memory_id = m.id and e.last_result = 'fail')`);
  if (f.q?.trim()) {
    const terms =
      f.q
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu)
        ?.slice(0, 10) ?? [];
    if (terms.length) add(`m.tsv @@ to_tsquery('simple', ?)`, terms.join(' | '));
  }
  const order = {
    updated: 'm.updated_at desc, m.id',
    created: 'm.created_at desc, m.id',
    confidence: 'm.confidence desc, m.id',
    expiry: 'm.expires_at asc nulls last, m.id',
  }[f.sort ?? 'updated'];
  const limit = Math.min(200, Math.max(1, f.limit ?? 50));
  const offset = Math.max(0, Number(f.cursor ?? 0) || 0);
  const rows = await tx.query<MemoryRow>(
    `select m.* from memories m where ${w.join(' and ')} order by ${order} limit ${limit + 1} offset ${offset}`,
    args,
  );
  const page = rows.rows.slice(0, limit);
  const recs = await loadMemories(tx, page);
  const verif = await tx.query<{ memory_id: string; results: string[] }>(
    `select memory_id, array_agg(coalesce(last_result,'unchecked')) as results from evidence where memory_id = any($1) group by memory_id`,
    [page.map((r) => r.id)],
  );
  const vmap = new Map(verif.rows.map((r) => [r.memory_id, r.results]));
  return {
    items: recs
      .map((m, i) => ({
        id: m.id,
        type: m.type,
        status: m.status,
        text: m.text,
        confidence: m.confidence,
        effectiveConfidence: Math.round(effectiveConfidence(m, deps.now(), cfg) * 1000) / 1000,
        agent: m.agent,
        branch: m.branch,
        evidence: m.evidence,
        evidenceResults: vmap.get(m.id) ?? [],
        flags: m.flags ?? [],
        writeState: m.writeState,
        blobId: m.blobId ?? null,
        expiresAt: m.expiresAt ? new Date(m.expiresAt).toISOString() : null,
        expired: !!m.expired,
        supersedesId: m.supersedesId ?? null,
        supersededById: m.supersededById ?? null,
        createdAt: new Date(m.createdAt).toISOString(),
        updatedAt: new Date(m.updatedAt).toISOString(),
        untrustedData: true,
        _row: page[i]!.id,
      }))
      .map(({ _row, ...rest }) => (void _row, rest)),
    nextCursor: rows.rows.length > limit ? String(offset + limit) : null,
  };
}

export async function memoryTimeline(tx: Tx, p: Principal, projectId: string, memoryId: string) {
  await loadProject(tx, p, projectId);
  assertAllowed(p, 'read');
  await loadMemoryRow(tx, projectId, memoryId);
  const r = await tx.query<{
    id: string;
    tier: string;
    type: string;
    payload: Record<string, unknown>;
    actor_kind: string;
    actor_id: string | null;
    created_at: Date;
    walrus_blob_id: string | null;
  }>(
    'select id, tier, type, payload, actor_kind, actor_id, created_at, walrus_blob_id from memory_events where memory_id = $1 order by created_at, seq',
    [memoryId],
  );
  const ev = await tx.query<{
    id: string;
    ref: Evidence;
    last_verified_at: Date | null;
    last_result: string | null;
    last_detail: unknown;
  }>(
    'select id, ref, last_verified_at, last_result, last_detail from evidence where memory_id = $1 order by id',
    [memoryId],
  );
  return { events: r.rows, evidence: ev.rows };
}

// ---------- agents ----------

export async function listAgents(deps: ServiceDeps, tx: Tx, p: Principal, projectId: string) {
  await loadProject(tx, p, projectId);
  assertAllowed(p, 'read');
  const since = new Date(deps.now() - 7 * 86_400_000);
  const r = await tx.query<{
    id: string;
    slug: string;
    name: string;
    tool: string;
    client_version: string | null;
    permissions: string[];
    branch_scope: string | null;
    created_at: Date;
    revoked_at: Date | null;
    last_seen_at: Date | null;
    writes: string;
    recalls: string;
    helped: string;
    wrong: string;
    token_last_used: Date | null;
  }>(
    `select a.id, a.slug, a.name, a.tool, a.client_version, a.permissions, a.branch_scope, a.created_at, a.revoked_at, a.last_seen_at,
            (select count(*) from activity_log l where l.project_id = a.project_id and l.actor_id = a.slug and l.operation in ('remember','handoff') and l.created_at >= $2) as writes,
            (select count(*) from activity_log l where l.project_id = a.project_id and l.actor_id = a.slug and l.operation = 'recall' and l.created_at >= $2) as recalls,
            (select count(*) from memory_events e where e.project_id = a.project_id and e.actor_id = a.slug and e.type = 'memory.reported' and e.payload->>'outcome' = 'helped' and e.created_at >= $2) as helped,
            (select count(*) from memory_events e where e.project_id = a.project_id and e.actor_id = a.slug and e.type = 'memory.reported' and e.payload->>'outcome' in ('wrong','outdated') and e.created_at >= $2) as wrong,
            (select max(last_used_at) from agent_tokens t where t.agent_id = a.id) as token_last_used
       from agents a where a.project_id = $1 order by a.created_at`,
    [projectId, since],
  );
  return r.rows.map((a) => ({
    id: a.id,
    slug: a.slug,
    name: a.name,
    tool: a.tool,
    clientVersion: a.client_version,
    permissions: a.permissions,
    branchScope: a.branch_scope,
    createdAt: a.created_at,
    revokedAt: a.revoked_at,
    lastSeenAt: a.last_seen_at,
    status: a.revoked_at
      ? 'revoked'
      : a.last_seen_at && deps.now() - new Date(a.last_seen_at).getTime() < 3_600_000
        ? 'active'
        : 'idle',
    writes7d: Number(a.writes),
    recalls7d: Number(a.recalls),
    helped7d: Number(a.helped),
    wrong7d: Number(a.wrong),
    tokenLastUsed: a.token_last_used,
  }));
}

export async function createAgentChecked(
  deps: ServiceDeps,
  p: Principal,
  projectId: string,
  input: { name: string; tool: string; permissions?: ('read' | 'write' | 'confirm')[]; branchScope?: string },
  enforce = true,
) {
  assertManage(p);
  await deps.db.tenant(p.workspaceId, async (tx) => {
    await loadProject(tx, p, projectId);
    await checkEntitlement(tx, p.workspaceId, 'agents', enforce);
  });
  return createAgent(deps, {
    workspaceId: p.workspaceId,
    projectId,
    name: input.name,
    tool: input.tool,
    ...(input.permissions ? { permissions: input.permissions } : {}),
    ...(input.branchScope ? { branchScope: input.branchScope } : {}),
    createdBy: (p as UserPrincipal).userId,
  });
}

export async function rotateAgentToken(
  deps: ServiceDeps,
  p: Principal,
  projectId: string,
  agentId: string,
): Promise<string> {
  assertManage(p);
  await deps.db.tenant(p.workspaceId, async (tx) => {
    await loadProject(tx, p, projectId);
    const a = await tx.query(
      'select 1 from agents where id = $1 and project_id = $2 and revoked_at is null',
      [agentId, projectId],
    );
    if (!a.rows.length) throw notFound('agent');
    await tx.query('update agent_tokens set revoked_at = $1 where agent_id = $2 and revoked_at is null', [
      new Date(deps.now()),
      agentId,
    ]);
  });
  return issueAgentToken(deps, p.workspaceId, agentId, (p as UserPrincipal).userId);
}

export async function revokeAgentChecked(
  deps: ServiceDeps,
  p: Principal,
  projectId: string,
  agentId: string,
) {
  assertManage(p);
  await deps.db.tenant(p.workspaceId, async (tx) => {
    await loadProject(tx, p, projectId);
    const a = await tx.query('select 1 from agents where id = $1 and project_id = $2', [agentId, projectId]);
    if (!a.rows.length) throw notFound('agent');
  });
  await revokeAgent(deps, p.workspaceId, agentId, (p as UserPrincipal).userId);
}

// ---------- activity ----------

export async function queryActivity(
  tx: Tx,
  p: Principal,
  projectId: string,
  f: { cursor?: string; limit?: number; operation?: string; actor?: string; result?: string },
) {
  await loadProject(tx, p, projectId);
  assertAllowed(p, 'read');
  const args: unknown[] = [projectId];
  const w = ['project_id = $1'];
  const add = (sql: string, v: unknown) => (args.push(v), w.push(sql.replace('?', `$${args.length}`)));
  if (f.operation) add('operation = ?', f.operation);
  if (f.actor) add('actor_id = ?', f.actor);
  if (f.result) add('result = ?', f.result);
  if (f.cursor) add('n < (select n from activity_log where id = ?)', f.cursor);
  const limit = Math.min(200, Math.max(1, f.limit ?? 50));
  const r = await tx.query<{
    id: string;
    actor_kind: string;
    actor_id: string | null;
    operation: string;
    target: unknown;
    result: string;
    latency_ms: number | null;
    request_id: string | null;
    detail: unknown;
    created_at: Date;
  }>(
    `select id, actor_kind, actor_id, operation, target, result, latency_ms, request_id, detail, created_at from activity_log where ${w.join(' and ')} order by n desc limit ${limit + 1}`,
    args,
  );
  return { items: r.rows.slice(0, limit), nextCursor: r.rows.length > limit ? r.rows[limit - 1]!.id : null };
}

/** Rows newer than the cursor, oldest first: backs the live feed (SSE). */
export async function activitySince(
  tx: Tx,
  p: Principal,
  projectId: string,
  afterId: string | null,
  limit = 100,
) {
  await loadProject(tx, p, projectId);
  assertAllowed(p, 'read');
  type Row = {
    id: string;
    actor_id: string | null;
    operation: string;
    result: string;
    target: unknown;
    latency_ms: number | null;
    created_at: Date;
  };
  const cols = 'id, actor_id, operation, result, target, latency_ms, created_at';
  // Ordered by the monotonic sequence, not by timestamp: rows written in the same millisecond must not be skipped.
  const r = afterId
    ? await tx.query<Row>(
        `select ${cols} from activity_log where project_id = $1 and n > coalesce((select n from activity_log where id = $2), 0) order by n limit $3`,
        [projectId, afterId, limit],
      )
    : await tx.query<Row>(
        `select * from (select ${cols}, n from activity_log where project_id = $1 order by n desc limit 20) x order by n`,
        [projectId],
      );
  return r.rows;
}

// ---------- verification + storage panels ----------

export async function verificationPanel(deps: ServiceDeps, tx: Tx, p: Principal, projectId: string) {
  const pr = await loadProject(tx, p, projectId);
  assertAllowed(p, 'read');
  const since = new Date(deps.now() - 24 * 3_600_000);
  const calls = await tx.query<{
    method: string;
    transport: string;
    n: string;
    avg_ms: string;
    errors: string;
    credits: string;
  }>(
    `select method, transport, count(*) as n, avg(latency_ms) as avg_ms, count(*) filter (where status = 'error') as errors, sum(credit_estimate) as credits from tatum_calls where workspace_id = $1 and created_at >= $2 group by method, transport order by n desc`,
    [p.workspaceId, since],
  );
  const hourly = await tx.query<{ hour: Date; transport: string; n: string }>(
    `select date_trunc('hour', created_at) as hour, transport, count(*) as n from tatum_calls where workspace_id = $1 and created_at >= $2 group by 1, 2 order by 1`,
    [p.workspaceId, since],
  );
  const evidence = await tx.query<{
    id: string;
    memory_id: string;
    kind: string;
    ref: Evidence;
    network: string | null;
    last_verified_at: Date | null;
    last_result: string | null;
  }>(
    `select e.id, e.memory_id, e.kind, e.ref, e.network, e.last_verified_at, e.last_result from evidence e join memories m on m.id = e.memory_id where m.project_id = $1 and e.kind in ('tx','object','package','file') order by e.last_verified_at nulls first limit 200`,
    [projectId],
  );
  const gw = deps.gateway?.status() ?? null;
  const credit = deps.gateway?.creditUsage(p.workspaceId) ?? null;
  const interval =
    ((pr.settings as { driftScanIntervalHours?: number }).driftScanIntervalHours ?? 6) * 3_600_000;
  return {
    gateway: gw ? { ...gw, configured: true } : { configured: false },
    credits: credit,
    networks: pr.networks,
    usage: {
      byMethod: calls.rows.map((c) => ({
        method: c.method,
        transport: c.transport,
        calls: Number(c.n),
        avgLatencyMs: Math.round(Number(c.avg_ms)),
        errors: Number(c.errors),
        credits: Number(c.credits),
      })),
      hourly: hourly.rows.map((h) => ({ hour: h.hour, transport: h.transport, calls: Number(h.n) })),
    },
    evidence: evidence.rows.map((e) => ({
      id: e.id,
      memoryId: e.memory_id,
      kind: e.kind,
      ref: e.ref,
      network: e.network,
      lastVerifiedAt: e.last_verified_at,
      result: e.last_result ?? 'unchecked',
      nextCheckAt: e.last_verified_at ? new Date(new Date(e.last_verified_at).getTime() + interval) : null,
    })),
  };
}

export async function storageHealth(deps: ServiceDeps, tx: Tx, p: Principal, projectId: string) {
  const pr = await loadProject(tx, p, projectId);
  assertAllowed(p, 'read');
  const relayer = await tx
    .query<{ reachable: boolean; write_state: string; version: string | null; checked_at: Date }>(
      'select reachable, write_state, version, checked_at from relayer_status order by checked_at desc limit 1',
    )
    .catch(() => ({ rows: [] }));
  const queue = await tx.query<{ state: string; n: string; oldest: string | number | null }>(
    'select state, count(*) as n, min(created_at) as oldest from write_jobs where project_id = $1 group by state',
    [projectId],
  );
  const dead = await tx.query<{ id: string; memory_id: string; last_error: string | null; attempts: number }>(
    `select id, memory_id, last_error, attempts from write_jobs where project_id = $1 and state = 'dead' order by created_at limit 50`,
    [projectId],
  );
  const expiring = await tx.query<{ id: string; text: string; expires_at: Date; expired: boolean }>(
    `select id, left(text, 140) as text, expires_at, expired from memories where project_id = $1 and expires_at is not null order by expires_at limit 50`,
    [projectId],
  );
  const stored = await tx.query<{ n: string }>(
    `select count(*) as n from memories where project_id = $1 and write_state = 'stored'`,
    [projectId],
  );
  return {
    relayer: relayer.rows[0]
      ? {
          reachable: relayer.rows[0].reachable,
          writeState: relayer.rows[0].write_state,
          version: relayer.rows[0].version,
          checkedAt: relayer.rows[0].checked_at,
        }
      : null,
    queue: Object.fromEntries(queue.rows.map((r) => [r.state, Number(r.n)])),
    oldestPendingAgeMs: queue.rows
      .filter((r) => ['queued', 'submitting', 'submitted'].includes(r.state) && r.oldest !== null)
      .reduce((m, r) => Math.max(m, deps.now() - Number(r.oldest)), 0),
    deadLetters: dead.rows,
    expiry: expiring.rows.map((m) => ({
      memoryId: m.id,
      text: m.text,
      expiresAt: m.expires_at,
      expired: m.expired,
    })),
    account: { mode: pr.walrus_account_id ? 'configured' : 'managed', accountId: pr.walrus_account_id },
    storedMemories: Number(stored.rows[0]!.n),
    deletion: {
      tombstone: 'Withdraws a memory from recall; the stored blob remains. Reversible.',
      indexRemoval: 'Removes search rows on the relayer; blobs remain and can be re-indexed.',
      permanentDeletion:
        'Owner-wallet-signed and irreversible; availability for current memories is unverified (ASSUMPTIONS A5).',
    },
  };
}

export async function retryDeadWrite(
  deps: ServiceDeps,
  tx: Tx,
  p: Principal,
  projectId: string,
  jobId: string,
) {
  assertAllowed(p, 'write');
  await loadProject(tx, p, projectId);
  const r = await tx.query(
    `update write_jobs set state = 'queued', attempts = 0, next_attempt_at = $1, lease_until = null, leased_by = null, updated_at = $1 where id = $2 and project_id = $3 and state = 'dead' returning id, memory_id`,
    [deps.now(), jobId, projectId],
  );
  if (!r.rows[0]) throw notFound('dead-lettered write');
  await tx.query(`update memories set write_state = 'queued' where id = $1 and write_state = 'failed'`, [
    (r.rows[0] as { memory_id: string }).memory_id,
  ]);
}

/** Storage and verification report: where the project's memories live on Walrus, when they expire, and how chain checks ran. */
export async function evidenceReport(
  deps: ServiceDeps,
  tx: Tx,
  p: Principal,
  projectId: string,
  cfg: { walrusNetwork?: string; delegatePublicKey?: string; relayerUrl?: string; tatumNetwork?: string },
) {
  const pr = await loadProject(tx, p, projectId);
  assertAllowed(p, 'read');
  const mem = await tx.query<{
    id: string;
    type: string;
    status: string;
    walrus_blob_id: string | null;
    expires_at: Date | null;
    end_epoch: number | null;
    created_at: Date;
    write_state: string;
  }>(
    `select id, type, status, walrus_blob_id, expires_at, end_epoch, created_at, write_state from memories where project_id = $1 and walrus_blob_id is not null order by created_at`,
    [projectId],
  );
  const calls = await tx.query<{
    n: string;
    avg: string;
    p95: string | null;
    credits: string;
    grpc: string;
    jsonrpc: string;
  }>(
    `select count(*) as n, avg(latency_ms) as avg, percentile_cont(0.95) within group (order by latency_ms) as p95, coalesce(sum(credit_estimate),0) as credits,
            count(*) filter (where transport = 'grpc') as grpc, count(*) filter (where transport = 'jsonrpc') as jsonrpc
       from tatum_calls where workspace_id = $1 and status <> 'cache_hit'`,
    [p.workspaceId],
  );
  const c = calls.rows[0]!;
  return {
    generatedAt: new Date(deps.now()).toISOString(),
    project: { id: pr.id, name: pr.name },
    walrus: {
      network: cfg.walrusNetwork ?? null,
      memWalAccountId: pr.walrus_account_id,
      agentId_delegatePublicKey: cfg.delegatePublicKey ?? null,
      relayerUrl: cfg.relayerUrl ?? null,
      storedMemories: mem.rows.length,
      memories: mem.rows.map((m) => ({
        memoryId: m.id,
        type: m.type,
        status: m.status,
        blobId: m.walrus_blob_id,
        expiresAt: m.expires_at ? new Date(m.expires_at).toISOString() : null,
        endEpoch: m.end_epoch,
      })),
      soonestExpiry:
        mem.rows
          .map((m) => m.expires_at)
          .filter(Boolean)
          .sort((a, b) => new Date(a!).getTime() - new Date(b!).getTime())[0] ?? null,
    },
    tatum: {
      network: cfg.tatumNetwork ?? null,
      calls: Number(c.n),
      grpcCalls: Number(c.grpc),
      jsonrpcCalls: Number(c.jsonrpc),
      avgLatencyMs: Math.round(Number(c.avg ?? 0)),
      p95LatencyMs: Math.round(Number(c.p95 ?? 0)),
      creditsEstimated: Number(c.credits),
    },
  };
}

// ---------- BUIRY.md ----------

export async function buiryMdFor(tx: Tx, p: Principal, projectId: string) {
  const pr = await loadProject(tx, p, projectId);
  assertAllowed(p, 'read');
  const snap = (pr.settings as { snapshot?: { text: string; generatedAt: string; hash: string } }).snapshot;
  return {
    projectId,
    networks: pr.networks,
    snapshot: snap ?? null,
    template: generateBuiryMd({ projectId, networks: pr.networks, ...(snap ? { snapshot: snap.text } : {}) }),
  };
}

// ---------- alert rules ----------

export async function listAlertRules(tx: Tx, p: Principal, projectId: string) {
  await loadProject(tx, p, projectId);
  assertAllowed(p, 'read');
  return (
    await tx.query(
      'select id, event, min_severity, channel, webhook_id, quiet_hours, grouping, enabled from alert_rules where project_id = $1 order by event',
      [projectId],
    )
  ).rows;
}

export async function upsertAlertRule(
  deps: ServiceDeps,
  tx: Tx,
  p: Principal,
  projectId: string,
  r: {
    id?: string;
    event: string;
    minSeverity?: string;
    channel?: string;
    webhookId?: string;
    quietHours?: { startHour: number; endHour: number } | null;
    grouping?: boolean;
    enabled?: boolean;
  },
) {
  assertManage(p);
  await loadProject(tx, p, projectId);
  if (!['dashboard', 'webhook'].includes(r.channel ?? 'dashboard'))
    throw new BuiryError('invalid_input', 'channel must be dashboard or webhook');
  if (r.webhookId) {
    const w = await tx.query('select 1 from webhooks where id = $1', [r.webhookId]);
    if (!w.rows.length) throw notFound('webhook');
  }
  const id = r.id ?? genId(deps, 'evt');
  await tx.query(
    `insert into alert_rules (id, workspace_id, project_id, event, min_severity, channel, webhook_id, quiet_hours, grouping, enabled) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (id) do update set event = $4, min_severity = $5, channel = $6, webhook_id = $7, quiet_hours = $8, grouping = $9, enabled = $10 where alert_rules.project_id = $3`,
    [
      id,
      p.workspaceId,
      projectId,
      r.event,
      r.minSeverity ?? 'warning',
      r.channel ?? 'dashboard',
      r.webhookId ?? null,
      r.quietHours ? JSON.stringify(r.quietHours) : null,
      r.grouping ?? true,
      r.enabled ?? true,
    ],
  );
  return { id };
}

// ---------- API tokens ----------

export const API_TOKEN_PREFIX = 'bry_pat_';
type Scope = 'read' | 'write' | 'admin';

export async function createApiToken(
  deps: ServiceDeps,
  tx: Tx,
  p: Principal,
  i: { name: string; scopes: Scope[]; projectIds?: string[]; expiresInDays?: number },
) {
  assertManage(p);
  if (!i.scopes.length || i.scopes.some((s) => !['read', 'write', 'admin'].includes(s)))
    throw new BuiryError('invalid_input', 'scopes must be read, write and/or admin');
  if (i.scopes.includes('admin') && p.role !== 'owner')
    throw new BuiryError('forbidden', 'only the owner can mint admin-scoped tokens');
  for (const id of i.projectIds ?? [])
    if (!(await tx.query('select 1 from projects where id = $1', [id])).rows.length)
      throw notFound('project');
  const token = API_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const id = genId(deps, 'evt');
  await tx.query(
    `insert into api_tokens (id, workspace_id, name, token_hash, prefix, scopes, project_ids, created_by, expires_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      p.workspaceId,
      i.name,
      hmac(deps.secretKey, token),
      token.slice(0, 12),
      i.scopes,
      i.projectIds ?? null,
      (p as UserPrincipal).userId,
      i.expiresInDays ? new Date(deps.now() + i.expiresInDays * 86_400_000) : null,
    ],
  );
  await logActivity(tx, deps, {
    workspaceId: p.workspaceId,
    actor: actorOf(p),
    operation: 'api_token.create',
    target: { tokenId: id },
    result: 'success',
  });
  return { id, token };
}

export async function listApiTokens(tx: Tx, p: Principal) {
  assertManage(p);
  return (
    await tx.query(
      'select id, name, prefix, scopes, project_ids, created_at, last_used_at, expires_at, revoked_at from api_tokens order by created_at desc',
    )
  ).rows;
}

export async function revokeApiToken(deps: ServiceDeps, tx: Tx, p: Principal, id: string) {
  assertManage(p);
  const r = await tx.query(
    'update api_tokens set revoked_at = $1 where id = $2 and revoked_at is null returning id',
    [new Date(deps.now()), id],
  );
  if (!r.rows[0]) throw notFound('token');
}

/** API tokens act as a synthetic member: read -> reader, write -> writer, admin -> admin. */
export async function authenticateApiToken(deps: ServiceDeps, token: string): Promise<UserPrincipal | null> {
  if (!token.startsWith(API_TOKEN_PREFIX)) return null;
  const r = await deps.db.system(async (tx) => {
    const x = await tx.query<{
      id: string;
      workspace_id: string;
      scopes: string[];
      project_ids: string[] | null;
      expires_at: Date | null;
      last_used_at: Date | null;
    }>(
      'select id, workspace_id, scopes, project_ids, expires_at, last_used_at from api_tokens where token_hash = $1 and revoked_at is null',
      [hmac(deps.secretKey, token)],
    );
    const t = x.rows[0];
    if (!t || (t.expires_at && new Date(t.expires_at).getTime() < deps.now())) return null;
    if (!t.last_used_at || deps.now() - new Date(t.last_used_at).getTime() > 60_000)
      await tx.query('update api_tokens set last_used_at = $1 where id = $2', [new Date(deps.now()), t.id]);
    return t;
  });
  if (!r) return null;
  const role = r.scopes.includes('admin') ? 'admin' : r.scopes.includes('write') ? 'writer' : 'reader';
  return {
    kind: 'user',
    workspaceId: r.workspace_id,
    userId: `token:${r.id}`,
    displayName: 'API token',
    role,
    projectScope: r.project_ids,
  };
}

// ---------- billing skeleton ----------

export async function billingSummary(tx: Tx, p: Principal) {
  assertManage(p);
  const ws = await tx.query<{ plan: string }>('select plan from workspaces where id = $1', [p.workspaceId]);
  const plan = (ws.rows[0]?.plan ?? 'free') as PlanName;
  const usage = await usageFor(tx, p.workspaceId);
  return {
    plan,
    limits: PLANS[plan] ?? PLANS.free,
    usage,
    prices: 'to be set',
    paymentMethods: [],
    invoices: [],
  };
}

// ---------- memory packs ----------

export interface PackMemory {
  id: string;
  type: MemoryType;
  status: Status;
  text: string;
  confidence: number;
  branch: string;
  agent: string;
  evidence: Evidence[];
  supersedes?: string;
  createdAt: string;
  /** The memory as a tier A `created` event (protocol text), so a pack is also a rebuildable record. */
  event: string;
}

export interface Pack {
  manifest: {
    protocol: 1;
    project: { name: string; networks: string[] };
    exportedAt: string;
    counts: { total: number; byType: Record<string, number> };
    checksum: string;
  };
  memories: PackMemory[];
}

const packChecksum = (m: PackMemory[]) =>
  createHash('sha256')
    .update(JSON.stringify(m.map((x) => [x.id, x.type, x.text, x.branch, x.evidence, x.event])))
    .digest('hex');

export async function exportPack(
  deps: ServiceDeps,
  tx: Tx,
  p: Principal,
  projectId: string,
  f: { branch?: string; types?: MemoryType[]; statuses?: Status[]; includeEvidence?: boolean },
): Promise<Pack> {
  const pr = await loadProject(tx, p, projectId);
  assertAllowed(p, 'read');
  const rows = await tx.query<MemoryRow>(
    `select * from memories where project_id = $1 and ($2::text is null or branch_slug = $2) and status = any($3) and expired = false and type = any($4) order by created_at`,
    [
      projectId,
      f.branch ?? null,
      f.statuses ?? ['confirmed', 'proposed', 'contested'],
      f.types ?? [...MEMORY_TYPES],
    ],
  );
  const ev = await evidenceFor(
    tx,
    rows.rows.map((r) => r.id),
  );
  const memories: PackMemory[] = rows.rows.map((r) => {
    const evidence = f.includeEvidence === false ? [] : (ev.get(r.id) ?? []);
    return {
      id: r.id,
      type: r.type,
      status: r.status,
      text: r.text,
      confidence: Number(r.confidence),
      branch: r.branch_slug,
      agent: r.agent_slug,
      evidence,
      ...(r.supersedes_id ? { supersedes: r.supersedes_id } : {}),
      createdAt: new Date(r.created_at).toISOString(),
      event: encodeMemory({
        header: { evt: 'memory.created', id: r.id, type: r.type, branch: r.branch_slug, agent: r.agent_slug },
        body: r.text,
        evidence,
      }),
    };
  });
  const byType: Record<string, number> = {};
  for (const m of memories) byType[m.type] = (byType[m.type] ?? 0) + 1;
  await tx.query(
    `insert into packs (id, workspace_id, project_id, direction, actor, counts, manifest) values ($1,$2,$3,'export',$4,$5,$6)`,
    [
      genId(deps, 'evt'),
      p.workspaceId,
      projectId,
      actorOf(p).id ?? null,
      JSON.stringify({ total: memories.length }),
      JSON.stringify({ name: pr.name }),
    ],
  );
  return {
    manifest: {
      protocol: 1,
      project: { name: pr.name, networks: pr.networks },
      exportedAt: new Date(deps.now()).toISOString(),
      counts: { total: memories.length, byType },
      checksum: packChecksum(memories),
    },
    memories,
  };
}

export interface PackPreview {
  valid: boolean;
  errors: string[];
  counts: { total: number; byType: Record<string, number> };
  items: {
    id: string;
    type: string;
    text: string;
    redaction: string[];
    blocked: boolean;
    injection: string[];
    duplicate: boolean;
  }[];
}

/** Validates a pack and runs redaction and the injection scanner on every item before anything is written. */
export async function previewPack(tx: Tx, p: Principal, projectId: string, pack: Pack): Promise<PackPreview> {
  await loadProject(tx, p, projectId);
  assertAllowed(p, 'write');
  const errors: string[] = [];
  if (pack?.manifest?.protocol !== 1) errors.push('unsupported pack protocol');
  if (!Array.isArray(pack?.memories)) errors.push('pack has no memories');
  if (errors.length) return { valid: false, errors, counts: { total: 0, byType: {} }, items: [] };
  if (pack.manifest.checksum !== packChecksum(pack.memories))
    errors.push('checksum mismatch: the pack was modified after export');
  const items: PackPreview['items'] = [];
  const byType: Record<string, number> = {};
  for (const m of pack.memories.slice(0, 2000)) {
    if (!(MEMORY_TYPES as readonly string[]).includes(m.type) || typeof m.text !== 'string') {
      errors.push(`invalid item ${String(m.id)}`);
      continue;
    }
    const dec = decodeMemory(m.event ?? '');
    if (m.event && !dec.ok) errors.push(`item ${m.id} has a malformed event`);
    if (dec.ok && dec.value.body !== m.text) errors.push(`item ${m.id} text does not match its event`);
    const red = redact(m.text);
    const inj = scanInjection(m.text);
    const dup =
      (
        await tx.query('select 1 from memories where project_id = $1 and idempotency_key = $2', [
          projectId,
          `client:pack:${pack.manifest.checksum}:${m.id}`,
        ])
      ).rows.length > 0;
    items.push({
      id: m.id,
      type: m.type,
      text: red.text,
      redaction: red.classes,
      blocked: red.blocked,
      injection: inj.matches,
      duplicate: dup,
    });
    byType[m.type] = (byType[m.type] ?? 0) + 1;
  }
  return { valid: errors.length === 0, errors, counts: { total: items.length, byType }, items };
}

/** Imported memories always arrive `proposed` (never confirmed), with the source id kept for lineage. */
export async function importPack(
  deps: ServiceDeps,
  p: Principal,
  projectId: string,
  pack: Pack,
  o: { branch?: string; only?: string[] },
) {
  const preview = await deps.db.tenant(p.workspaceId, (tx) => previewPack(tx, p, projectId, pack));
  if (!preview.valid) throw new BuiryError('invalid_input', `pack rejected: ${preview.errors.join('; ')}`);
  const results: { sourceId: string; memoryId?: string; skipped?: string }[] = [];
  for (const m of pack.memories) {
    if (o.only && !o.only.includes(m.id)) continue;
    const pv = preview.items.find((i) => i.id === m.id);
    if (!pv || pv.blocked) {
      results.push({ sourceId: m.id, skipped: 'blocked by redaction' });
      continue;
    }
    if (pv.duplicate) {
      results.push({ sourceId: m.id, skipped: 'already imported' });
      continue;
    }
    const out = await deps.db.tenant(p.workspaceId, (tx) =>
      createMemoryTx(
        deps,
        tx,
        p,
        projectId,
        {
          text: m.text,
          type: m.type,
          evidence: m.evidence,
          ...(o.branch ? { branch: o.branch } : {}),
          idempotencyKey: `pack:${pack.manifest.checksum}:${m.id}`,
        },
        { skipConflicts: true, mergedFrom: m.id },
      ),
    );
    results.push({ sourceId: m.id, memoryId: out.memoryId });
  }
  await deps.db.tenant(p.workspaceId, (tx) =>
    tx.query(
      `insert into packs (id, workspace_id, project_id, direction, actor, counts, manifest) values ($1,$2,$3,'import',$4,$5,$6)`,
      [
        genId(deps, 'evt'),
        p.workspaceId,
        projectId,
        actorOf(p).id ?? null,
        JSON.stringify({
          imported: results.filter((r) => r.memoryId).length,
          skipped: results.filter((r) => r.skipped).length,
        }),
        JSON.stringify(pack.manifest),
      ],
    ),
  );
  return {
    imported: results.filter((r) => r.memoryId).length,
    skipped: results.filter((r) => r.skipped).length,
    results,
  };
}

export async function listPacks(tx: Tx, p: Principal, projectId: string) {
  await loadProject(tx, p, projectId);
  assertAllowed(p, 'read');
  return (
    await tx.query(
      'select id, direction, actor, counts, created_at from packs where project_id = $1 order by created_at desc limit 50',
      [projectId],
    )
  ).rows;
}

// ---------- gateway telemetry sink ----------

import type { CallRecord, CallSink } from '@buiry/chain';

/** Persists every gateway call (method, transport, latency, status, credit estimate) for the verification panel. */
export function tatumCallSink(deps: ServiceDeps): CallSink {
  return {
    record: async (r: CallRecord) => {
      await deps.db
        .system((tx) =>
          tx.query(
            `insert into tatum_calls (id, workspace_id, method, transport, network, latency_ms, status, error_kind, credit_estimate, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              genId(deps, 'evt'),
              r.workspaceId ?? null,
              r.method,
              r.transport,
              r.network,
              r.latencyMs,
              r.status,
              r.errorKind ?? null,
              r.creditEstimate,
              new Date(r.at),
            ],
          ),
        )
        .catch(() => {});
    },
  };
}
