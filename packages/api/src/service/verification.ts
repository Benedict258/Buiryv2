import {
  BuiryError,
  relevance,
  type ChainReadInput,
  type ChainReadOutput,
  type ChainSimulateInput,
  type ChainSimulateOutput,
  type Evidence,
  type RememberInput,
  type VerifyInput,
  type VerifyOutput,
  type VerifyResultItem,
} from '@buiry/core';
import {
  ChainError,
  simulateToFailure,
  verifyEvidence,
  type VerifyContext,
  type VerifyOutcome,
} from '@buiry/chain';
import type { Tx } from '../db/db.js';
import {
  applyToMemory,
  assertAllowed,
  createMemoryTx,
  loadMemoryRow,
  loadProject,
  raiseFlag,
  type ProjectRow,
} from './ops.js';
import type { Principal, ServiceDeps, UserPrincipal } from './types.js';
import { actorOf, evidenceFor, genId, logActivity, notFound, type MemoryRow } from './util.js';

export const CHAIN_KINDS: Evidence['kind'][] = ['tx', 'object', 'package'];
const isChain = (e: Evidence) => CHAIN_KINDS.includes(e.kind);

export const systemPrincipal = (workspaceId: string): UserPrincipal => ({
  kind: 'user',
  workspaceId,
  userId: 'system',
  displayName: 'Buiry verification',
  role: 'admin',
  projectScope: null,
});

export function mapChainError(e: unknown): Error {
  if (e instanceof BuiryError) return e;
  if (e instanceof ChainError) {
    if (e.kind === 'budget_exceeded') return new BuiryError('budget_exceeded', e.message);
    if (e.kind === 'invalid') return new BuiryError('invalid_input', e.message);
    return new BuiryError('verification_unavailable', `chain gateway: ${e.message}`, 30_000, {
      kind: e.kind,
    });
  }
  // Anything else (a database error, a bug) is rethrown as it is: the HTTP error handler answers with the stable
  // `internal` code and a generic message, and logs one line with the error class and Postgres code, never the message
  // (SECURITY_REVIEW M5, sweep A1). The raw message can quote stored values.
  return e instanceof Error ? e : new Error('non-error value thrown');
}

async function withTimeout<T>(ms: number, fn: () => Promise<T>): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), ms))),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function verifyCtx(
  deps: ServiceDeps,
  project: Pick<ProjectRow, 'networks'>,
  workspaceId: string,
): VerifyContext | null {
  if (!deps.gateway) return null;
  return { gateway: deps.gateway, declaredNetworks: project.networks, workspaceId };
}

/** Inline, bounded verification of chain evidence before a write (+0.25 confidence when it passes). */
export async function preVerify(
  deps: ServiceDeps,
  p: Principal,
  project: ProjectRow,
  evidence: Evidence[] | undefined,
) {
  const chain = (evidence ?? []).filter(isChain);
  const ctx = verifyCtx(deps, project, p.workspaceId);
  if (!ctx || chain.length === 0) return undefined;
  const outs = await withTimeout(deps.verifyTimeoutMs ?? 4000, () =>
    Promise.all(chain.map((e) => verifyEvidence(e, ctx))),
  );
  if (outs === 'timeout') return undefined;
  const extra: Evidence[] = [];
  for (const o of outs)
    for (const x of o.extracted ?? [])
      if (!(evidence ?? []).some((e) => JSON.stringify(e) === JSON.stringify(x))) extra.push(x);
  return {
    verified: outs.every((o) => o.result === 'pass'),
    extra: extra.slice(0, 5),
    failures: outs.filter((o) => o.result === 'fail').map((o) => o.detail),
    // Definite outcomes are stored on the evidence rows, so the dashboard and the next check see them; an unknown
    // (gateway outage) is not a result and is left for a later check.
    checked: chain
      .map((e, i) => ({ key: JSON.stringify(e), result: outs[i]!.result, detail: outs[i]!.detail }))
      .filter((c) => c.result === 'pass' || c.result === 'fail'),
  };
}

interface EvRow {
  id: string;
  ref: Evidence;
}

/**
 * Verifies a memory's chain/repo evidence (or a loose evidence item). Gateway I/O happens outside any
 * database transaction. An outage returns unknown and never changes a memory's status.
 */
export async function verifyOp(
  deps: ServiceDeps,
  p: Principal,
  projectId: string,
  i: VerifyInput,
  opts: { repo?: VerifyContext['repo']; auto?: boolean } = {},
): Promise<VerifyOutput> {
  const t0 = deps.now();
  if (!i.memoryId && !i.evidence) throw new BuiryError('invalid_input', 'provide memoryId or evidence');
  const { project, rows, row } = await deps.db.tenant(p.workspaceId, async (tx) => {
    const project = await loadProject(tx, p, projectId);
    assertAllowed(p, 'read');
    if (!i.memoryId) return { project, rows: [] as EvRow[], row: null };
    const row = await loadMemoryRow(tx, projectId, i.memoryId);
    const r = await tx.query<EvRow>('select id, ref from evidence where memory_id = $1 order by id', [
      row.id,
    ]);
    return { project, rows: r.rows, row };
  });
  const ctx = verifyCtx(deps, project, p.workspaceId);
  const targets: { id?: string; ev: Evidence }[] = i.memoryId
    ? rows.map((r) => ({ id: r.id, ev: r.ref }))
    : [{ ev: i.evidence! }];
  const checkable = targets.filter((t) => isChain(t.ev) || t.ev.kind === 'file');
  if (!ctx && checkable.some((t) => isChain(t.ev))) {
    throw new BuiryError(
      'verification_unavailable',
      'the chain gateway is not configured for this deployment',
      60_000,
    );
  }
  const outcomes: { t: (typeof targets)[number]; o: VerifyOutcome }[] = [];
  for (const t of targets) {
    if (!isChain(t.ev) && t.ev.kind !== 'file') {
      outcomes.push({
        t,
        o: { result: 'unknown', detail: `${t.ev.kind} evidence is not machine-checkable` },
      });
      continue;
    }
    // An explicit verify (tool call or dashboard) revalidates; automatic checks may use the short cache.
    const vctx: VerifyContext = ctx
      ? { ...ctx, ...(opts.auto ? {} : { fresh: true }), ...(opts.repo ? { repo: opts.repo } : {}) }
      : {
          gateway: undefined as never,
          declaredNetworks: project.networks,
          ...(opts.repo ? { repo: opts.repo } : {}),
        };
    outcomes.push({ t, o: await verifyEvidence(t.ev, vctx) });
  }

  const result = await deps.db.tenant(p.workspaceId, async (tx) => {
    const at = new Date(deps.now());
    let statusOut: VerifyOutput['status'];
    const extracted: Evidence[] = [];
    for (const { t, o } of outcomes) {
      await tx.query(
        `insert into verifications (id, workspace_id, project_id, memory_id, evidence_id, kind, result, detail, observed, degraded, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          genId(deps, 'ver'),
          p.workspaceId,
          projectId,
          row?.id ?? null,
          t.id ?? null,
          t.ev.kind,
          o.result,
          o.detail,
          JSON.stringify(o.observed ?? {}),
          o.degraded ?? false,
          at,
        ],
      );
      if (t.id) {
        await tx.query(
          'update evidence set last_verified_at = $1, last_result = $2, last_detail = $3 where id = $4',
          [at, o.result, JSON.stringify({ detail: o.detail, observed: o.observed ?? {} }), t.id],
        );
      }
      extracted.push(...(o.extracted ?? []));
    }
    if (row) {
      const locked = await loadMemoryRow(tx, projectId, row.id, true);
      statusOut = locked.status;
      const definite = outcomes.filter((x) => !x.o.degraded && x.o.result !== 'unknown');
      const failed = definite.filter((x) => x.o.result === 'fail');
      const passed = definite.filter((x) => x.o.result === 'pass');
      const sysP: Principal = opts.auto || p.kind === 'agent' ? p : p;
      const repoOnly = failed.length > 0 && failed.every((x) => x.t.ev.kind === 'file');
      if (repoOnly) {
        // A changed file means "review this memory", not "this memory is false": flag, never stale.
        if (!['superseded', 'tombstoned'].includes(locked.status)) {
          await raiseFlag(deps, tx, {
            workspaceId: p.workspaceId,
            projectId,
            memoryId: locked.id,
            kind: 'needs_review',
            severity: 'warning',
            detail: failed.map((x) => x.o.detail).join('; '),
          });
        }
      } else if (
        failed.length &&
        locked.status !== 'stale' &&
        locked.status !== 'superseded' &&
        locked.status !== 'tombstoned'
      ) {
        const detail = failed.map((x) => x.o.detail).join('; ');
        const a = await applyToMemory(
          deps,
          tx,
          sysP,
          project,
          locked,
          { kind: 'verify', result: 'fail' },
          { reason: detail, tierBType: 'memory.validated', extra: { detail } },
        );
        statusOut = a.after.status;
        await raiseFlag(deps, tx, {
          workspaceId: p.workspaceId,
          projectId,
          memoryId: locked.id,
          kind: 'stale',
          severity: locked.type === 'deployment' ? 'critical' : 'warning',
          detail,
        });
      } else if (
        !failed.length &&
        passed.length &&
        ['proposed', 'confirmed', 'contested'].includes(locked.status)
      ) {
        const a = await applyToMemory(
          deps,
          tx,
          sysP,
          project,
          locked,
          { kind: 'verify', result: 'pass' },
          { reason: 'evidence re-confirmed', tierBType: 'memory.validated' },
        );
        statusOut = a.after.status;
      }
      // A successful transaction on a deployment memory contributes the identifiers it created.
      if (locked.type === 'deployment' && extracted.length && locked.status !== 'tombstoned') {
        const have = (await evidenceFor(tx, [locked.id])).get(locked.id) ?? [];
        for (const e of extracted) {
          if (have.some((h) => JSON.stringify(h) === JSON.stringify(e))) continue;
          await tx.query(
            `insert into evidence (id, workspace_id, memory_id, kind, ref, network) values ($1,$2,$3,$4,$5,$6)`,
            [
              genId(deps, 'evt'),
              p.workspaceId,
              locked.id,
              e.kind,
              JSON.stringify(e),
              'network' in e ? e.network : null,
            ],
          );
        }
      }
    }
    if (!opts.auto) {
      await logActivity(tx, deps, {
        workspaceId: p.workspaceId,
        projectId,
        actor: actorOf(p),
        operation: 'verify',
        target: { memoryId: row?.id ?? null },
        result: 'success',
        latencyMs: deps.now() - t0,
        detail: { results: outcomes.map((x) => x.o.result), degraded: outcomes.some((x) => x.o.degraded) },
      });
    }
    return { statusOut, extracted };
  });
  const results: VerifyResultItem[] = outcomes.map(({ t, o }) => ({
    evidence: t.ev,
    result: o.result,
    detail: o.detail,
    degraded: o.degraded ?? false,
    ...(o.observed ? { observed: o.observed } : {}),
  }));
  return {
    ...(row ? { memoryId: row.id } : {}),
    results,
    ...(result.statusOut ? { status: result.statusOut } : {}),
    ...(result.extracted.length ? { extracted: result.extracted } : {}),
  };
}

/** At check time, re-verify the few task-relevant memories whose chain evidence is stale (FR-V4). */
export async function reverifyForTask(
  deps: ServiceDeps,
  p: Principal,
  projectId: string,
  task: string | undefined,
): Promise<number> {
  if (!deps.gateway) return 0;
  const cutoff = new Date(deps.now() - (deps.reverifyAfterMs ?? 6 * 3_600_000));
  const candidates = await deps.db.tenant(p.workspaceId, async (tx) => {
    const r = await tx.query<MemoryRow>(
      `select m.* from memories m where m.project_id = $1 and m.status in ('proposed','confirmed','contested') and m.expired = false
         and exists (select 1 from evidence e where e.memory_id = m.id and e.kind in ('tx','object','package') and (e.last_verified_at is null or e.last_verified_at < $2))
       order by m.updated_at desc limit 40`,
      [projectId, cutoff],
    );
    return r.rows;
  });
  const ranked = candidates
    .map((m) => ({ m, s: task ? relevance(task, m.text) : 0, deploy: m.type === 'deployment' ? 1 : 0 }))
    .sort((a, b) => b.s + b.deploy * 0.2 - (a.s + a.deploy * 0.2))
    .slice(0, 3);
  // In parallel: the caller waits at most its budget, so sequential calls would only waste it.
  const done = await Promise.all(
    ranked.map(({ m }) =>
      withTimeout(deps.verifyTimeoutMs ?? 4000, () =>
        verifyOp(deps, p, projectId, { memoryId: m.id }, { auto: true }).catch(() => null),
      ),
    ),
  );
  return done.filter((r) => r && r !== 'timeout').length;
}

// ---------- chain read / simulate ----------

function resolveNetwork(deps: ServiceDeps, project: ProjectRow, requested?: string): string {
  const declared = project.networks;
  const net = requested ?? declared.find((n) => n.startsWith('sui:')) ?? deps.gateway?.defaultNetwork;
  if (!net) throw new BuiryError('invalid_input', 'no network declared for this project; pass network');
  if (declared.length && !declared.includes(net))
    throw new BuiryError(
      'forbidden',
      `network ${net} is not declared by this project (declared: ${declared.join(', ')})`,
    );
  return net;
}

export async function chainReadOp(
  deps: ServiceDeps,
  p: Principal,
  projectId: string,
  i: ChainReadInput,
): Promise<ChainReadOutput> {
  const t0 = deps.now();
  const project = await deps.db.tenant(p.workspaceId, async (tx) => {
    const pr = await loadProject(tx, p, projectId);
    assertAllowed(p, 'read');
    return pr;
  });
  if (!deps.gateway)
    throw new BuiryError(
      'verification_unavailable',
      'the chain gateway is not configured for this deployment',
      60_000,
    );
  const network = resolveNetwork(deps, project, i.network);
  const o = { network, workspaceId: p.workspaceId };
  try {
    let data: unknown;
    let prov: { transport: string; latencyMs: number; cached: boolean };
    if (i.kind === 'epoch') {
      const r = await deps.gateway.getEpoch(o);
      [data, prov] = [r.value, r.prov];
    } else {
      if (!i.identifier) throw new BuiryError('invalid_input', 'identifier is required');
      const r =
        i.kind === 'transaction'
          ? await deps.gateway.getTransaction(i.identifier, o)
          : i.kind === 'object'
            ? await deps.gateway.getObject(i.identifier, o)
            : await deps.gateway.listPackageVersions(i.identifier, o);
      [data, prov] = [r.value, r.prov];
    }
    await deps.db.tenant(p.workspaceId, (tx) =>
      logActivity(tx, deps, {
        workspaceId: p.workspaceId,
        projectId,
        actor: actorOf(p),
        operation: 'chain_read',
        target: { kind: i.kind, network },
        result: 'success',
        latencyMs: deps.now() - t0,
        detail: { transport: prov.transport },
      }),
    );
    return {
      kind: i.kind,
      network,
      data,
      provenance: { transport: prov.transport, latencyMs: prov.latencyMs, cached: prov.cached },
    };
  } catch (e) {
    throw mapChainError(e);
  }
}

export async function chainSimulateOp(
  deps: ServiceDeps,
  p: Principal,
  projectId: string,
  i: ChainSimulateInput,
): Promise<ChainSimulateOutput> {
  const t0 = deps.now();
  const project = await deps.db.tenant(p.workspaceId, async (tx) => {
    const pr = await loadProject(tx, p, projectId);
    assertAllowed(p, 'read');
    return pr;
  });
  if (!deps.gateway)
    throw new BuiryError(
      'verification_unavailable',
      'the chain gateway is not configured for this deployment',
      60_000,
    );
  const network = resolveNetwork(deps, project, i.network);
  const out = await simulateToFailure(
    { bcsBase64: i.transactionBcsBase64 },
    network,
    { gateway: deps.gateway, declaredNetworks: project.networks, workspaceId: p.workspaceId },
    i.label ?? 'drafted transaction',
  );
  if (out.degraded) throw mapChainError(new ChainError('unavailable', out.detail));
  let failureMemoryId: string | undefined;
  if (out.failureDraft && i.createFailureMemory) {
    const input: RememberInput = {
      text: out.failureDraft.text,
      type: 'failure',
      ...(i.branch ? { branch: i.branch } : {}),
    };
    failureMemoryId = (
      await deps.db.tenant(p.workspaceId, (tx) => createMemoryTx(deps, tx, p, projectId, input))
    ).memoryId;
  }
  await deps.db.tenant(p.workspaceId, (tx) =>
    logActivity(tx, deps, {
      workspaceId: p.workspaceId,
      projectId,
      actor: actorOf(p),
      operation: 'chain_simulate',
      target: { network },
      result: 'success',
      latencyMs: deps.now() - t0,
      detail: { success: out.result === 'pass', failureMemoryId: failureMemoryId ?? null },
    }),
  );
  return {
    success: out.result === 'pass',
    detail: out.detail,
    ...(failureMemoryId ? { failureMemoryId } : {}),
  };
}

export { notFound };
export type { Tx };

/** Repository evidence: the CLI computes hashes locally and sends only results (path -> exists/changed). */
export async function verifyRepoEvidence(
  deps: ServiceDeps,
  p: Principal,
  projectId: string,
  repo: NonNullable<VerifyContext['repo']>,
): Promise<{
  checked: number;
  changed: { memoryId: string; path: string; detail: string }[];
  unchanged: number;
  unknown: number;
}> {
  const mems = await deps.db.tenant(p.workspaceId, async (tx) => {
    await loadProject(tx, p, projectId);
    assertAllowed(p, 'write');
    const r = await tx.query<{ id: string }>(
      `select distinct m.id from memories m join evidence e on e.memory_id = m.id
        where m.project_id = $1 and e.kind = 'file' and m.status in ('proposed','confirmed','contested') and m.expired = false`,
      [projectId],
    );
    return r.rows;
  });
  const out = {
    checked: 0,
    changed: [] as { memoryId: string; path: string; detail: string }[],
    unchanged: 0,
    unknown: 0,
  };
  for (const m of mems) {
    const v = await verifyOp(deps, p, projectId, { memoryId: m.id }, { repo, auto: true });
    out.checked++;
    for (const r of v.results.filter((x) => x.evidence.kind === 'file')) {
      if (r.result === 'fail')
        out.changed.push({ memoryId: m.id, path: (r.evidence as { path: string }).path, detail: r.detail });
      else if (r.result === 'pass') out.unchanged++;
      else out.unknown++;
    }
  }
  return out;
}
