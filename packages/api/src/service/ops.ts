import {
  BuiryError,
  applySignal,
  decodeMemory,
  deriveNamespace,
  encodeMemory,
  findConflictCandidates,
  initialState,
  isValidBranchSlug,
  redact,
  scanInjection,
  type Actor,
  type Evidence,
  type EventType,
  type LearningState,
  type MemoryType,
  type RememberInput,
  type RememberOutput,
  type ResolveInput,
  type ResolveOutput,
  type ReportInput,
  type ReportOutput,
  type Signal,
  type Status,
  MEMORY_TYPES,
  DEFAULT_LEARNING,
} from '@buiry/core';
import { PgWriteQueue, WriteService, type IndexedMemory } from '@buiry/storage';
import type { Tx } from '../db/db.js';
import type { AgentPrincipal, Principal, ServiceDeps } from './types.js';
import { actorOf, genId, loadMemories, logActivity, notFound, sha, type MemoryRow } from './util.js';

export const MAX_EVIDENCE = 8;
const ROLE_RANK = { reader: 0, writer: 1, admin: 2, owner: 3 } as const;

export interface ProjectRow {
  id: string;
  workspace_id: string;
  name: string;
  networks: string[];
  settings: Record<string, unknown>;
  walrus_account_id: string | null;
}
export interface BranchRow {
  id: string;
  slug: string;
  namespace: string;
  protected: boolean;
  archived_at: Date | null;
  merged_at: Date | null;
}

// ---------- authorization ----------

export type Need = 'read' | 'write' | 'confirm' | 'tombstone' | 'merge';

export function assertAllowed(
  p: Principal,
  need: Need,
  branch?: { slug: string; protected: boolean },
  settings?: Record<string, unknown>,
): void {
  if (p.kind === 'agent') {
    if (need === 'merge')
      throw new BuiryError(
        'forbidden',
        'agents cannot merge branches; ask a person to merge from the dashboard',
      );
    const perm = need === 'read' ? 'read' : need === 'confirm' ? 'confirm' : 'write';
    if (!p.permissions.includes(perm))
      throw new BuiryError('forbidden', `this agent token lacks the "${perm}" permission`);
    if (need !== 'read' && branch && p.branchScope && branch.slug !== p.branchScope) {
      throw new BuiryError('forbidden', `this agent is limited to branch "${p.branchScope}"`);
    }
    if (need === 'write' && branch?.protected && settings?.allowProposedOnMain === false) {
      throw new BuiryError(
        'forbidden',
        `branch "${branch.slug}" is protected: write to a feature branch and propose a merge`,
      );
    }
    return;
  }
  const need2 = need === 'read' ? 0 : need === 'merge' ? (branch?.protected ? 2 : 1) : 1;
  if (ROLE_RANK[p.role] < need2) {
    throw new BuiryError(
      'forbidden',
      `your role (${p.role}) cannot do this; ${need2 === 2 ? 'an admin' : 'a writer'} is required`,
    );
  }
}

export function scopeProject(p: Principal, projectId: string): void {
  if (p.kind === 'agent' && p.projectId !== projectId) throw notFound('project');
  if (p.kind === 'user' && p.projectScope && !p.projectScope.includes(projectId)) throw notFound('project');
}

export async function loadProject(tx: Tx, p: Principal, projectId: string): Promise<ProjectRow> {
  scopeProject(p, projectId);
  const r = await tx.query<ProjectRow>(
    'select id, workspace_id, name, networks, settings, walrus_account_id from projects where id = $1 and archived_at is null',
    [projectId],
  );
  if (!r.rows[0]) throw notFound('project');
  return r.rows[0];
}

export async function loadBranch(tx: Tx, projectId: string, slug: string): Promise<BranchRow> {
  if (!isValidBranchSlug(slug)) throw new BuiryError('invalid_input', `invalid branch name "${slug}"`);
  const r = await tx.query<BranchRow>(
    'select id, slug, namespace, protected, archived_at, merged_at from branches where project_id = $1 and slug = $2',
    [projectId, slug],
  );
  if (!r.rows[0]) throw notFound(`branch "${slug}"`);
  return r.rows[0];
}

export async function loadMemoryRow(
  tx: Tx,
  projectId: string,
  memoryId: string,
  lock = false,
): Promise<MemoryRow> {
  const r = await tx.query<MemoryRow>(
    `select * from memories where id = $1 and project_id = $2${lock ? ' for update' : ''}`,
    [memoryId, projectId],
  );
  if (!r.rows[0]) throw notFound('memory');
  return r.rows[0];
}

export const humanSlug = (p: Principal): string => (p.kind === 'agent' ? p.agentSlug : `user-${p.userId}`);

export function actorFor(p: Principal): Actor {
  return p.kind === 'agent'
    ? { kind: 'agent', id: p.agentSlug, sessionId: p.sessionId }
    : { kind: 'human', id: p.userId };
}

// ---------- durable events ----------

export interface DurableArgs {
  p: Principal;
  project: ProjectRow;
  branch: { slug: string; namespace: string };
  memoryId: string;
  evt: EventType;
  body: string;
  evidence?: Evidence[];
  type?: MemoryType;
  by?: string;
  ref?: string;
  payload?: Record<string, unknown>;
  seq: number;
  force?: boolean;
}

/** Records a tier A event and queues its Walrus write in the same transaction. */
export async function emitDurable(
  deps: ServiceDeps,
  tx: Tx,
  a: DurableArgs,
): Promise<{ eventId: string; jobId?: string }> {
  const red = redact(a.body);
  if (red.blocked) throw new BuiryError('redaction_blocked', `event text contains ${red.classes.join(', ')}`);
  const eventId = genId(deps, 'evt');
  const text = encodeMemory({
    header: {
      evt: a.evt,
      id: a.memoryId,
      branch: a.branch.slug,
      agent: humanSlug(a.p),
      ...(a.type ? { type: a.type } : {}),
      ...(a.by ? { by: a.by } : {}),
      ...(a.ref ? { ref: a.ref } : {}),
    },
    body: red.text.replace(/\r/g, ''),
    evidence: a.evidence ?? [],
  });
  const header = text.split('\n', 1)[0]!;
  await tx.query(
    `insert into memory_events (id, workspace_id, memory_id, project_id, tier, type, payload, actor_kind, actor_id, seq, created_at)
     values ($1,$2,$3,$4,'A',$5,$6,$7,$8,$9,$10)`,
    [
      eventId,
      a.p.workspaceId,
      a.memoryId,
      a.project.id,
      a.evt,
      JSON.stringify(a.payload ?? {}),
      a.p.kind === 'agent' ? 'agent' : 'user',
      a.p.kind === 'agent' ? a.p.agentSlug : a.p.userId,
      a.seq,
      new Date(deps.now()),
    ],
  );
  const svc = new WriteService(new PgWriteQueue(tx), deps.now, deps.random, deps.budgets);
  const r = await svc.accept(
    {
      memoryId: a.memoryId,
      namespace: a.branch.namespace,
      projectId: a.project.id,
      agentId: humanSlug(a.p),
      header,
      text,
      ref: eventId,
    },
    { force: a.force ?? false },
  );
  if (!r.ok) {
    throw new BuiryError('budget_exceeded', r.message, r.retryAfterMs, { scope: r.scope });
  }
  return { eventId, jobId: r.jobId };
}

export async function recordLocalEvent(
  deps: ServiceDeps,
  tx: Tx,
  a: {
    p: Principal;
    projectId: string;
    memoryId: string;
    type: EventType;
    payload: Record<string, unknown>;
    seq: number;
  },
): Promise<void> {
  await tx.query(
    `insert into memory_events (id, workspace_id, memory_id, project_id, tier, type, payload, actor_kind, actor_id, seq, created_at)
     values ($1,$2,$3,$4,'B',$5,$6,$7,$8,$9,$10)`,
    [
      genId(deps, 'evt'),
      a.p.workspaceId,
      a.memoryId,
      a.projectId,
      a.type,
      JSON.stringify(a.payload),
      a.p.kind === 'agent' ? 'agent' : 'user',
      a.p.kind === 'agent' ? a.p.agentSlug : a.p.userId,
      a.seq,
      new Date(deps.now()),
    ],
  );
}

export async function raiseFlag(
  deps: ServiceDeps,
  tx: Tx,
  a: {
    workspaceId: string;
    projectId: string;
    memoryId?: string;
    kind: string;
    severity: 'critical' | 'warning' | 'info';
    detail: string;
  },
): Promise<void> {
  const existing = await tx.query<{ id: string }>(
    `select id from flags where project_id = $1 and kind = $2 and coalesce(memory_id,'') = $3 and state <> 'resolved'`,
    [a.projectId, a.kind, a.memoryId ?? ''],
  );
  if (existing.rows[0]) {
    await tx.query('update flags set last_seen = $1, detail = $2, severity = $3 where id = $4', [
      new Date(deps.now()),
      a.detail,
      a.severity,
      existing.rows[0].id,
    ]);
    return;
  }
  await tx.query(
    `insert into flags (id, workspace_id, project_id, memory_id, kind, severity, detail, group_key, first_seen, last_seen)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
    [
      genId(deps, 'flg'),
      a.workspaceId,
      a.projectId,
      a.memoryId ?? null,
      a.kind,
      a.severity,
      a.detail,
      `${a.kind}:${a.memoryId ?? 'project'}`,
      new Date(deps.now()),
    ],
  );
}

// ---------- learning state persistence ----------

export function stateFromRow(r: MemoryRow): LearningState {
  const l = r.learning as Partial<LearningState> & { createdBySession?: string };
  const lr =
    r.last_reinforced_at instanceof Date
      ? r.last_reinforced_at.getTime()
      : Date.parse(r.last_reinforced_at as string);
  return {
    id: r.id,
    type: r.type,
    status: r.status,
    confidence: Number(r.confidence),
    lastReinforcedAt: lr,
    createdByAgent: (l.createdByAgent as string | undefined) ?? r.agent_slug,
    ...(l.createdBySession ? { createdBySession: l.createdBySession } : {}),
    helpfulByDay: l.helpfulByDay ?? {},
    promotionSessions: l.promotionSessions ?? [],
    promotionReports: l.promotionReports ?? 0,
    wrongCount: l.wrongCount ?? 0,
    history: [],
  };
}

const learningJson = (s: LearningState) => ({
  helpfulByDay: s.helpfulByDay,
  promotionSessions: s.promotionSessions,
  promotionReports: s.promotionReports,
  wrongCount: s.wrongCount,
  createdByAgent: s.createdByAgent,
  ...(s.createdBySession ? { createdBySession: s.createdBySession } : {}),
});

const DURABLE_FOR_STATUS: Partial<Record<Status, EventType>> = {
  confirmed: 'memory.confirmed',
  contested: 'memory.contested',
  stale: 'memory.stale',
  superseded: 'memory.superseded',
  tombstoned: 'memory.tombstoned',
};

export interface Applied {
  applied: boolean;
  reason: string;
  before: { status: Status; confidence: number };
  after: { status: Status; confidence: number };
  seq: number;
}

/** Applies a learning signal to a locked memory row, persists it, and emits the durable event if status changed. */
export async function applyToMemory(
  deps: ServiceDeps,
  tx: Tx,
  p: Principal,
  project: ProjectRow,
  row: MemoryRow,
  signal: Signal,
  note?: { reason?: string; by?: string; tierBType?: EventType; extra?: Record<string, unknown> },
): Promise<Applied> {
  const at = deps.now();
  const before = { status: row.status, confidence: Number(row.confidence) };
  const res = applySignal(stateFromRow(row), signal, at, deps.learning ?? DEFAULT_LEARNING);
  if (!res.applied) {
    return { applied: false, reason: res.reason, before, after: before, seq: row.seq };
  }
  const s = res.state;
  const seq = row.seq + 1;
  await tx.query(
    `update memories set status = $1, confidence = $2, last_reinforced_at = $3, learning = $4, updated_at = $5, seq = $6 where id = $7`,
    [
      s.status,
      s.confidence,
      new Date(s.lastReinforcedAt),
      JSON.stringify(learningJson(s)),
      new Date(at),
      seq,
      row.id,
    ],
  );
  const change = s.history[s.history.length - 1]!;
  if (note?.tierBType) {
    await recordLocalEvent(deps, tx, {
      p,
      projectId: project.id,
      memoryId: row.id,
      type: note.tierBType,
      seq,
      payload: {
        signal: change.signal,
        before: change.before,
        after: change.after,
        reason: res.reason,
        ...(note.extra ?? {}),
      },
    });
  }
  if (s.status !== before.status) {
    const evt = DURABLE_FOR_STATUS[s.status];
    if (evt) {
      const branch = await loadBranch(tx, project.id, row.branch_slug);
      const label = p.kind === 'agent' ? `agent ${p.agentSlug}` : `${p.displayName}`;
      await emitDurable(deps, tx, {
        p,
        project,
        branch,
        memoryId: row.id,
        evt,
        body: `${evt.replace('memory.', '').replace(/^./, (c) => c.toUpperCase())} by ${label}${note?.reason ? `: ${note.reason}` : `: ${res.reason}`} [seq ${seq}]`,
        ...(note?.by ? { by: note.by } : {}),
        seq,
        force: true,
        payload: { before: change.before, after: change.after, reason: res.reason },
      });
    }
  }
  return {
    applied: true,
    reason: res.reason,
    before,
    after: { status: s.status, confidence: s.confidence },
    seq,
  };
}

// ---------- create ----------

export interface CreateOptions {
  /** Event name for the durable write: handoffs use handoff.created. */
  evt?: 'memory.created' | 'handoff.created';
  /** Humans may create confirmed memories directly. */
  confirmed?: boolean;
  /** Skip the conflict scan (system-created memories such as handoffs). */
  skipConflicts?: boolean;
  /** Evidence already verified by the caller (e.g. a simulation draft). */
  evidenceVerified?: boolean;
  /** Extra evidence discovered by verification (e.g. package ids from a tx). */
  mergedFrom?: string;
}

function validateEvidence(ev: Evidence[] | undefined): Evidence[] {
  const list = ev ?? [];
  if (list.length > MAX_EVIDENCE)
    throw new BuiryError('invalid_input', `at most ${MAX_EVIDENCE} evidence items per memory`);
  return list.map((e) => {
    if (e.kind === 'url') {
      const r = redact(e.href);
      if (r.blocked)
        throw new BuiryError('redaction_blocked', `evidence url contains ${r.classes.join(', ')}`);
      return { ...e, href: r.text };
    }
    return e;
  });
}

export async function createMemoryTx(
  deps: ServiceDeps,
  tx: Tx,
  p: Principal,
  projectId: string,
  input: RememberInput,
  opts: CreateOptions = {},
  pre?: { verified?: boolean; extra?: Evidence[]; failures?: string[] },
): Promise<RememberOutput> {
  const t0 = deps.now();
  const project = await loadProject(tx, p, projectId);
  if (!(MEMORY_TYPES as readonly string[]).includes(input.type))
    throw new BuiryError('invalid_input', `unknown memory type "${input.type}"`);
  const text = (input.text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!text) throw new BuiryError('invalid_input', 'text is required');
  const max = deps.maxTextLength ?? 4000;
  if (text.length > max)
    throw new BuiryError(
      'invalid_input',
      `text is ${text.length} characters; keep memories under ${max}. Store a summary and a reference instead.`,
    );

  const slug = input.branch ?? (p.kind === 'agent' ? await activeBranch(tx, p) : 'main');
  const branch = await loadBranch(tx, projectId, slug);
  if (branch.archived_at || branch.merged_at) throw new BuiryError('conflict', `branch "${slug}" is closed`);
  assertAllowed(p, 'write', branch, project.settings);

  const red = redact(text, redactionOptions(project.settings));
  if (red.blocked) {
    throw new BuiryError(
      'redaction_blocked',
      `memory text contains ${red.classes.join(', ')}; rephrase without the secret. Nothing was stored.`,
      undefined,
      { kinds: red.classes },
    );
  }
  const evidence = [...validateEvidence(input.evidence), ...(pre?.extra ?? [])];

  // Request-level idempotency: a replayed call (reconnect) returns the original memory.
  const requestKey = input.idempotencyKey
    ? `client:${input.idempotencyKey}`
    : sha(JSON.stringify(['v1', projectId, slug, input.type, red.text, evidence, humanSlug(p)]));
  const dup = await tx.query<MemoryRow>(
    'select * from memories where project_id = $1 and idempotency_key = $2',
    [projectId, requestKey],
  );
  if (dup.rows[0]) {
    const d = dup.rows[0];
    return {
      memoryId: d.id,
      state: d.write_state,
      status: d.status,
      duplicate: true,
      redaction: { applied: false, kinds: [] },
      conflictCandidates: [],
    };
  }

  // Conflict candidates (text similarity only; never changes status).
  let candidates: RememberOutput['conflictCandidates'] = [];
  if (!opts.skipConflicts) {
    const pool = await tx.query<MemoryRow>(
      `select * from memories where project_id = $1 and branch_slug = any($2) and status not in ('superseded','tombstoned') and expired = false
         and type in ('decision','constraint','fact','procedure','preference') order by updated_at desc limit 300`,
      [projectId, slug === 'main' ? ['main'] : [slug, 'main']],
    );
    candidates = findConflictCandidates(
      { text: red.text, type: input.type },
      pool.rows.map((r) => ({ id: r.id, text: r.text, type: r.type, status: r.status })),
      deps.learning ?? DEFAULT_LEARNING,
    );
  }

  let target: MemoryRow | null = null;
  if (input.relation) {
    target = await loadMemoryRow(
      tx,
      projectId,
      input.relation.memoryId,
      input.relation.kind === 'supersedes',
    );
    if (input.relation.kind === 'supersedes')
      assertAllowed(p, 'write', { slug: target.branch_slug, protected: false });
  }

  const id = genId(deps, 'mem');
  const actor = actorFor(p);
  const asConfirmed = p.kind === 'user' && (opts.confirmed ?? false);
  const st = initialState({
    id,
    type: input.type,
    actor: asConfirmed
      ? { kind: 'human', id: actor.id }
      : { kind: 'agent', id: actor.id, ...(actor.sessionId ? { sessionId: actor.sessionId } : {}) },
    at: t0,
    evidenceVerified: pre?.verified ?? opts.evidenceVerified ?? false,
    cfg: deps.learning ?? DEFAULT_LEARNING,
  });
  const flags: string[] = [];
  if (candidates.length && !input.relation) flags.push('possible_conflict');
  if (scanInjection(red.text).flagged) flags.push('injection_suspect');
  if (red.classes.length) flags.push('redacted');

  const evt = opts.evt ?? 'memory.created';
  await tx.query(
    `insert into memories (id, workspace_id, project_id, branch_id, branch_slug, type, status, text, confidence, agent_slug, agent_id, actor_kind, session_id,
        created_at, updated_at, last_reinforced_at, supersedes_id, ref_memory_id, write_state, flags, learning, idempotency_key, seq)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$14,$15,$16,'queued',$17,$18,$19,1)`,
    [
      id,
      p.workspaceId,
      projectId,
      branch.id,
      slug,
      input.type,
      st.status,
      red.text,
      st.confidence,
      humanSlug(p),
      p.kind === 'agent' ? p.agentId : null,
      p.kind === 'agent' ? 'agent' : 'human',
      actor.sessionId ?? null,
      new Date(t0),
      input.relation?.kind === 'supersedes' ? input.relation.memoryId : null,
      opts.mergedFrom ?? null,
      flags,
      JSON.stringify(learningJson(st)),
      requestKey,
    ],
  );
  for (const e of evidence) {
    await tx.query(
      `insert into evidence (id, workspace_id, memory_id, kind, ref, network) values ($1,$2,$3,$4,$5,$6)`,
      [genId(deps, 'evt'), p.workspaceId, id, e.kind, JSON.stringify(e), 'network' in e ? e.network : null],
    );
  }
  await emitDurable(deps, tx, {
    p,
    project,
    branch,
    memoryId: id,
    evt,
    type: input.type,
    body: red.text,
    evidence,
    ...(input.relation?.kind === 'supersedes' ? { ref: input.relation.memoryId } : {}),
    seq: 1,
    payload: { confidence: st.confidence, status: st.status },
  });

  if (target && input.relation?.kind === 'supersedes') {
    const r = await applyToMemory(
      deps,
      tx,
      p,
      project,
      target,
      { kind: 'supersede' },
      { reason: `replaced by ${id}`, by: id, tierBType: 'memory.reported' },
    );
    await tx.query('update memories set superseded_by_id = $1 where id = $2', [id, target.id]);
    void r;
  }
  if (flags.includes('possible_conflict')) {
    await raiseFlag(deps, tx, {
      workspaceId: p.workspaceId,
      projectId,
      memoryId: id,
      kind: 'possible_conflict',
      severity: 'info',
      detail: `Similar to ${candidates.map((c) => c.memoryId).join(', ')}; declare supersedes, distinct or agrees`,
    });
  }
  if (pre?.failures?.length) {
    await raiseFlag(deps, tx, {
      workspaceId: p.workspaceId,
      projectId,
      memoryId: id,
      kind: 'verification',
      severity: 'warning',
      detail: `Evidence failed verification at write: ${pre.failures.join('; ')}`,
    });
  }
  if (flags.includes('injection_suspect')) {
    await raiseFlag(deps, tx, {
      workspaceId: p.workspaceId,
      projectId,
      memoryId: id,
      kind: 'injection',
      severity: 'warning',
      detail: 'Memory text contains instruction-like patterns aimed at agents',
    });
  }
  await logActivity(tx, deps, {
    workspaceId: p.workspaceId,
    projectId,
    actor: actorOf(p),
    operation: evt === 'handoff.created' ? 'handoff' : 'remember',
    target: { memoryId: id, type: input.type, branch: slug },
    result: 'queued',
    latencyMs: deps.now() - t0,
    detail: { redaction: red.classes, conflicts: candidates.length },
  });
  return {
    memoryId: id,
    state: 'queued',
    status: st.status,
    duplicate: false,
    redaction: { applied: red.classes.length > 0, kinds: red.classes },
    conflictCandidates: candidates,
  };
}

export function redactionOptions(settings: Record<string, unknown>) {
  const r = (settings.redaction ?? {}) as { custom?: never[]; maskEmails?: boolean; maskPhones?: boolean };
  return {
    ...(r.custom ? { custom: r.custom } : {}),
    ...(r.maskEmails !== undefined ? { maskEmails: r.maskEmails } : {}),
    ...(r.maskPhones !== undefined ? { maskPhones: r.maskPhones } : {}),
  };
}

export async function activeBranch(tx: Tx, p: AgentPrincipal): Promise<string> {
  const r = await tx.query<{ active_branch: string }>('select active_branch from agents where id = $1', [
    p.agentId,
  ]);
  return r.rows[0]?.active_branch ?? 'main';
}

// ---------- report / resolve ----------

export async function reportTx(
  deps: ServiceDeps,
  tx: Tx,
  p: Principal,
  projectId: string,
  i: ReportInput,
): Promise<ReportOutput> {
  const t0 = deps.now();
  const project = await loadProject(tx, p, projectId);
  assertAllowed(p, 'read');
  if (!['helped', 'wrong', 'irrelevant', 'outdated'].includes(i.outcome))
    throw new BuiryError('invalid_input', 'unknown outcome');
  const row = await loadMemoryRow(tx, projectId, i.memoryId, true);
  const note = i.note ? redact(i.note).text.slice(0, 500) : undefined;
  const a = await applyToMemory(
    deps,
    tx,
    p,
    project,
    row,
    { kind: 'report', actor: actorFor(p), outcome: i.outcome },
    {
      tierBType: 'memory.reported',
      extra: { outcome: i.outcome, ...(note ? { note } : {}) },
    },
  );
  if (a.after.status === 'contested' && a.before.status !== 'contested') {
    await raiseFlag(deps, tx, {
      workspaceId: p.workspaceId,
      projectId,
      memoryId: row.id,
      kind: 'contested',
      severity: 'warning',
      detail: 'Reported wrong more than once',
    });
  }
  await logActivity(tx, deps, {
    workspaceId: p.workspaceId,
    projectId,
    actor: actorOf(p),
    operation: 'report',
    target: { memoryId: row.id, outcome: i.outcome },
    result: 'success',
    latencyMs: deps.now() - t0,
    detail: { applied: a.applied, reason: a.reason },
  });
  return {
    memoryId: row.id,
    confidence: Math.round(a.after.confidence * 1000) / 1000,
    status: a.after.status,
    applied: a.applied,
    reason: a.reason,
  };
}

export async function resolveTx(
  deps: ServiceDeps,
  tx: Tx,
  p: Principal,
  projectId: string,
  i: ResolveInput,
): Promise<ResolveOutput> {
  const t0 = deps.now();
  const project = await loadProject(tx, p, projectId);
  const row = await loadMemoryRow(tx, projectId, i.memoryId, true);
  const branch = { slug: row.branch_slug, protected: false };
  const reason = i.reason ? redact(i.reason).text.slice(0, 500) : undefined;
  let signal: Signal;
  switch (i.action) {
    case 'confirm':
      assertAllowed(p, 'confirm', branch);
      signal = { kind: 'confirm', actor: actorFor(p), delegated: p.kind === 'agent' };
      break;
    case 'contest':
      assertAllowed(p, p.kind === 'agent' ? 'confirm' : 'write', branch);
      signal = { kind: 'contest', actor: actorFor(p) };
      break;
    case 'tombstone':
      assertAllowed(p, 'write', branch);
      signal = { kind: 'tombstone' };
      break;
    case 'supersede': {
      assertAllowed(p, 'write', branch);
      if (!i.supersededBy)
        throw new BuiryError('invalid_input', 'supersededBy is required to supersede a memory');
      const by = await loadMemoryRow(tx, projectId, i.supersededBy);
      if (by.id === row.id) throw new BuiryError('invalid_input', 'a memory cannot supersede itself');
      signal = { kind: 'supersede' };
      await tx.query('update memories set superseded_by_id = $1 where id = $2', [by.id, row.id]);
      await tx.query('update memories set supersedes_id = $1 where id = $2 and supersedes_id is null', [
        row.id,
        by.id,
      ]);
      break;
    }
    default:
      throw new BuiryError('invalid_input', 'unknown action');
  }
  const a = await applyToMemory(deps, tx, p, project, row, signal, {
    ...(reason ? { reason } : {}),
    ...(i.supersededBy ? { by: i.supersededBy } : {}),
    tierBType: 'memory.reported',
  });
  if (!a.applied) {
    throw new BuiryError(i.action === 'confirm' ? 'forbidden' : 'conflict', a.reason);
  }
  if (a.after.status === 'confirmed' || a.after.status === 'tombstoned' || a.after.status === 'superseded') {
    await tx.query(
      `update flags set state = 'resolved', resolved_at = $1 where memory_id = $2 and state <> 'resolved' and kind in ('possible_conflict','contested','needs_review')`,
      [new Date(deps.now()), row.id],
    );
  }
  await logActivity(tx, deps, {
    workspaceId: p.workspaceId,
    projectId,
    actor: actorOf(p),
    operation: 'resolve',
    target: { memoryId: row.id, action: i.action },
    result: 'success',
    latencyMs: deps.now() - t0,
    detail: reason ? { reason } : {},
  });
  return {
    memoryId: row.id,
    status: a.after.status,
    confidence: Math.round(a.after.confidence * 1000) / 1000,
  };
}

export { deriveNamespace, decodeMemory, loadMemories };
export type { IndexedMemory };
