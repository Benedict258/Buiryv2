import {
  BuiryError,
  type BranchInput,
  type BuiryBackend,
  type ChainReadInput,
  type ChainSimulateInput,
  type CheckInput,
  type ConnectInput,
  type HandoffInput,
  type RecallInput,
  type RememberBulkOutput,
  type RememberInput,
  type ReportInput,
  type ResolveInput,
  type VerifyInput,
} from '@buiry/core';
import { branchOp, briefingTx, checkTx, connectTx, getMemoryTx, recallOp, statusOp } from './queries.js';
import { createMemoryTx, loadBranch, loadMemoryRow, loadProject, reportTx, resolveTx } from './ops.js';
import { chainReadOp, chainSimulateOp, preVerify, reverifyForTask, verifyOp } from './verification.js';
import type { AgentPrincipal, Principal, ServiceDeps } from './types.js';
import { genId, logActivity } from './util.js';

/** Per-agent call rate limiter (tokens refill continuously). */
export class AgentRateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly perMinute: number,
    private readonly now: () => number,
  ) {}
  take(key: string): void {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.perMinute, at: t };
    b.tokens = Math.min(this.perMinute, b.tokens + ((t - b.at) / 60_000) * this.perMinute);
    b.at = t;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      throw new BuiryError(
        'rate_limited',
        `agent call limit of ${this.perMinute}/minute reached`,
        Math.ceil(((1 - b.tokens) / this.perMinute) * 60_000),
      );
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
  }
}

/** Operations shared by agents (MCP/REST) and people (dashboard). Every call is scoped by a principal. */
export class MemoryService {
  constructor(readonly deps: ServiceDeps) {}

  async remember(p: Principal, projectId: string, input: RememberInput, o: { confirmed?: boolean } = {}) {
    const project = await this.deps.db.tenant(p.workspaceId, (tx) => loadProject(tx, p, projectId));
    const pre = await preVerify(this.deps, p, project, input.evidence);
    return this.deps.db.tenant(p.workspaceId, (tx) =>
      createMemoryTx(this.deps, tx, p, projectId, input, o.confirmed ? { confirmed: true } : {}, pre),
    );
  }

  async rememberBulk(p: Principal, projectId: string, items: RememberInput[]): Promise<RememberBulkOutput> {
    if (items.length === 0 || items.length > 20)
      throw new BuiryError('invalid_input', 'send between 1 and 20 items');
    const results: RememberBulkOutput['results'] = [];
    for (const item of items) {
      try {
        results.push({ ok: true, result: await this.remember(p, projectId, item) });
      } catch (e) {
        if (e instanceof BuiryError) results.push({ ok: false, error: e.toJSON() });
        else throw e;
      }
    }
    return { results };
  }

  recall(p: Principal, projectId: string, i: RecallInput) {
    return recallOp(this.deps, p, projectId, i);
  }

  report(p: Principal, projectId: string, i: ReportInput) {
    return this.deps.db.tenant(p.workspaceId, (tx) => reportTx(this.deps, tx, p, projectId, i));
  }

  resolve(p: Principal, projectId: string, i: ResolveInput) {
    return this.deps.db.tenant(p.workspaceId, (tx) => resolveTx(this.deps, tx, p, projectId, i));
  }

  async handoff(p: Principal, projectId: string, i: HandoffInput) {
    if (![i.done, i.blocked, i.next].every(Array.isArray))
      throw new BuiryError('invalid_input', 'done, blocked and next must be lists');
    return this.deps.db.tenant(p.workspaceId, async (tx) => {
      const slug =
        i.branch ??
        (p.kind === 'agent'
          ? ((
              await tx.query<{ active_branch: string }>('select active_branch from agents where id = $1', [
                p.agentId,
              ])
            ).rows[0]?.active_branch ?? 'main')
          : 'main');
      await loadBranch(tx, projectId, slug);
      const relied = i.reliedOn ?? [];
      for (const id of relied) await loadMemoryRow(tx, projectId, id);
      const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '- none');
      const text = [
        `Handoff from ${p.kind === 'agent' ? p.agentSlug : p.displayName}.`,
        'Done:',
        list(i.done),
        'Blocked:',
        list(i.blocked),
        'Next:',
        list(i.next),
        ...(relied.length ? [`Relied on: ${relied.join(', ')}`] : []),
        ...(i.notes ? [`Notes: ${i.notes}`] : []),
      ].join('\n');
      const out = await createMemoryTx(
        this.deps,
        tx,
        p,
        projectId,
        { text, type: 'handoff', branch: slug },
        { evt: 'handoff.created', skipConflicts: true },
      );
      if (out.duplicate) {
        const h = await tx.query<{ id: string }>('select id from handoffs where memory_id = $1', [
          out.memoryId,
        ]);
        return { handoffId: h.rows[0]?.id ?? out.memoryId, memoryId: out.memoryId, state: out.state };
      }
      const handoffId = genId(this.deps, 'hnd');
      await tx.query(
        `insert into handoffs (id, workspace_id, project_id, branch_slug, memory_id, agent_slug, done, blocked, next, relied_on, notes, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          handoffId,
          p.workspaceId,
          projectId,
          slug,
          out.memoryId,
          p.kind === 'agent' ? p.agentSlug : `user-${p.userId}`,
          JSON.stringify(i.done),
          JSON.stringify(i.blocked),
          JSON.stringify(i.next),
          relied,
          i.notes ?? null,
          new Date(this.deps.now()),
        ],
      );
      return { handoffId, memoryId: out.memoryId, state: out.state };
    });
  }

  verify(p: Principal, projectId: string, i: VerifyInput) {
    return verifyOp(this.deps, p, projectId, i);
  }
  chainRead(p: Principal, projectId: string, i: ChainReadInput) {
    return chainReadOp(this.deps, p, projectId, i);
  }
  chainSimulate(p: Principal, projectId: string, i: ChainSimulateInput) {
    return chainSimulateOp(this.deps, p, projectId, i);
  }
  branch(p: Principal, projectId: string, i: BranchInput) {
    return this.deps.db.tenant(p.workspaceId, (tx) => branchOp(this.deps, tx, p, projectId, i));
  }
  status(p: Principal, projectId: string) {
    return statusOp(this.deps, p, projectId);
  }
  getMemory(p: Principal, projectId: string, memoryId: string) {
    return this.deps.db.tenant(p.workspaceId, (tx) => getMemoryTx(this.deps, tx, p, projectId, memoryId));
  }

  /** Briefing preview for people (dashboard) and for the BUIRY.md snapshot; does not touch agent state. */
  briefingPreview(p: Principal, projectId: string, i: CheckInput & { onboarding?: boolean }) {
    return this.deps.db.tenant(p.workspaceId, async (tx) => {
      const out = await briefingTx(
        this.deps,
        tx,
        p,
        projectId,
        { ...i, onboardingOverride: i.onboarding ?? false },
        i.branch ?? 'main',
      );
      return { ...out, items: out.items };
    });
  }
}

/** The authenticated agent's view of the service: this is what the MCP server and /v1/agent REST call. */
export class AgentBackend implements BuiryBackend {
  constructor(
    private readonly svc: MemoryService,
    readonly principal: AgentPrincipal,
    private readonly limiter?: AgentRateLimiter,
  ) {}

  private get p() {
    return this.principal;
  }
  private get pid() {
    return this.principal.projectId;
  }
  private async guard<T>(op: string, fn: () => Promise<T>): Promise<T> {
    this.limiter?.take(this.p.agentId);
    const t0 = this.svc.deps.now();
    try {
      return await fn();
    } catch (e) {
      if (e instanceof BuiryError && e.code !== 'unauthorized') {
        await this.svc.deps.db
          .tenant(this.p.workspaceId, (tx) =>
            logActivity(tx, this.svc.deps, {
              workspaceId: this.p.workspaceId,
              projectId: this.pid,
              actor: { kind: 'agent', id: this.p.agentSlug },
              operation: op,
              result: 'error',
              latencyMs: this.svc.deps.now() - t0,
              detail: { code: e.code, message: e.message },
            }),
          )
          .catch(() => {});
      }
      throw e;
    }
  }

  connect(i: ConnectInput) {
    return this.guard('connect', () =>
      this.svc.deps.db.tenant(this.p.workspaceId, (tx) => connectTx(this.svc.deps, tx, this.p, i)),
    );
  }
  async check(i: CheckInput) {
    return this.guard('check', async () => {
      await reverifyForTask(this.svc.deps, this.p, this.pid, i.task).catch(() => 0);
      return this.svc.deps.db.tenant(this.p.workspaceId, (tx) => checkTx(this.svc.deps, tx, this.p, i));
    });
  }
  remember(i: RememberInput) {
    return this.guard('remember', () => this.svc.remember(this.p, this.pid, i));
  }
  rememberBulk(items: RememberInput[]) {
    return this.guard('remember', () => this.svc.rememberBulk(this.p, this.pid, items));
  }
  recall(i: RecallInput) {
    return this.guard('recall', () => this.svc.recall(this.p, this.pid, i));
  }
  report(i: ReportInput) {
    return this.guard('report', () => this.svc.report(this.p, this.pid, i));
  }
  resolve(i: ResolveInput) {
    return this.guard('resolve', () => this.svc.resolve(this.p, this.pid, i));
  }
  handoff(i: HandoffInput) {
    return this.guard('handoff', () => this.svc.handoff(this.p, this.pid, i));
  }
  verify(i: VerifyInput) {
    return this.guard('verify', () => this.svc.verify(this.p, this.pid, i));
  }
  chainRead(i: ChainReadInput) {
    return this.guard('chain_read', () => this.svc.chainRead(this.p, this.pid, i));
  }
  chainSimulate(i: ChainSimulateInput) {
    return this.guard('chain_simulate', () => this.svc.chainSimulate(this.p, this.pid, i));
  }
  branch(i: BranchInput) {
    return this.guard('branch', () => this.svc.branch(this.p, this.pid, i));
  }
  status() {
    return this.guard('status', () => this.svc.status(this.p, this.pid));
  }
  getMemory(memoryId: string) {
    return this.guard('get_memory', () => this.svc.getMemory(this.p, this.pid, memoryId));
  }
  async getBriefing(branch?: string) {
    return this.guard('briefing', async () => {
      const { items: _i, ...rest } = await this.svc.briefingPreview(this.p, this.pid, {
        ...(branch ? { branch } : {}),
      });
      void _i;
      return rest;
    });
  }
  getProject() {
    return this.guard('get_project', () =>
      this.svc.deps.db.tenant(this.p.workspaceId, (tx) => connectTx(this.svc.deps, tx, this.p, {})),
    );
  }
}
