import type { Evidence } from '@buiry/core';
import { ChainError, type Network, type Verdict } from './types.js';
import type { CallContext, Result, TatumGateway } from './tatum.js';

/** What verifiers need from the gateway; keeps them testable and prevents any other chain access. */
export type GatewayLike = Pick<
  TatumGateway,
  | 'getTransaction'
  | 'getObject'
  | 'listPackageVersions'
  | 'getFunction'
  | 'simulate'
  | 'getEpoch'
  | 'evmRpc'
  | 'networks'
>;

export interface RepoFileResult {
  exists: boolean;
  changed: boolean;
  currentCommit?: string;
}

export interface VerifyContext {
  gateway: GatewayLike;
  /** Networks the project declares; used for network sanity. */
  declaredNetworks: Network[];
  workspaceId?: string;
  /** Explicit verification: read current chain state, not the short-lived cache. */
  fresh?: boolean;
  /** Results computed client-side by the CLI (path -> result). Only results reach the server. */
  repo?: Record<string, RepoFileResult>;
}

export interface FailureDraft {
  type: 'failure';
  text: string;
  evidence: Evidence[];
}

export interface VerifyOutcome {
  result: Verdict;
  detail: string;
  observed?: Record<string, unknown>;
  /** Identifiers pulled from a transaction, to become evidence on a deployment memory. */
  extracted?: Evidence[];
  /** True when the verdict is `unknown` because the gateway was unavailable (never marks anything stale). */
  degraded?: boolean;
  /** Draft failure memory (simulation). */
  failureDraft?: FailureDraft;
}

export interface Verifier {
  readonly kind: Evidence['kind'];
  verify(ev: Evidence, ctx: VerifyContext): Promise<VerifyOutcome>;
}

export function normalizeSuiId(id: string): string {
  const h = id.trim().toLowerCase().replace(/^0x/, '');
  return /^[0-9a-f]{1,64}$/.test(h) ? '0x' + h.padStart(64, '0') : id.trim();
}

const call = (ctx: VerifyContext, network: Network): CallContext & { network: Network } => ({
  network,
  ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
  ...(ctx.fresh ? { fresh: true } : {}),
});

/** Outages, throttling and budget exhaustion yield `unknown` + degraded: never a fail. */
export function degradedOutcome(e: unknown): VerifyOutcome {
  if (e instanceof ChainError) {
    const why =
      e.kind === 'config'
        ? 'gateway configuration error (check the API key); not retried'
        : e.kind === 'budget_exceeded'
          ? 'verification credit budget exhausted'
          : e.kind === 'rate_limited'
            ? 'gateway rate limited'
            : e.kind === 'unsupported'
              ? `not available on the configured transport: ${e.message}`
              : e.kind === 'unavailable'
                ? 'gateway unavailable'
                : e.message;
    return { result: 'unknown', detail: why, degraded: true, observed: { errorKind: e.kind } };
  }
  return { result: 'unknown', detail: 'verification error', degraded: true }; // sweep A7: no exception text
}

async function guard(fn: () => Promise<VerifyOutcome>): Promise<VerifyOutcome> {
  try {
    return await fn();
  } catch (e) {
    return degradedOutcome(e);
  }
}

// ---------- network sanity ----------

export type IdentifierKind = 'tx' | 'object' | 'package';

/** Looks for an identifier on the other configured Sui networks. Returns networks where it exists. */
export async function probeOtherNetworks(
  id: string,
  kind: IdentifierKind,
  not: Network,
  ctx: VerifyContext,
): Promise<Network[]> {
  const found: Network[] = [];
  for (const n of ctx.gateway.networks) {
    if (n === not || !n.startsWith('sui:')) continue;
    try {
      if (kind === 'tx') {
        if ((await ctx.gateway.getTransaction(id, call(ctx, n))).value) found.push(n);
      } else if (kind === 'object') {
        if ((await ctx.gateway.getObject(normalizeSuiId(id), call(ctx, n))).value.found) found.push(n);
      } else if ((await ctx.gateway.listPackageVersions(normalizeSuiId(id), call(ctx, n))).value)
        found.push(n);
    } catch {
      /* a probe failure is not evidence */
    }
  }
  return found;
}

export async function checkNetworkSanity(
  id: string,
  kind: IdentifierKind,
  ctx: VerifyContext,
): Promise<VerifyOutcome> {
  return guard(async () => {
    for (const declared of ctx.declaredNetworks.filter((n) => n.startsWith('sui:'))) {
      const here =
        kind === 'tx'
          ? (await ctx.gateway.getTransaction(id, call(ctx, declared))).value !== null
          : kind === 'object'
            ? (await ctx.gateway.getObject(normalizeSuiId(id), call(ctx, declared))).value.found
            : (await ctx.gateway.listPackageVersions(normalizeSuiId(id), call(ctx, declared))).value !== null;
      if (here)
        return {
          result: 'pass',
          detail: `found on ${declared}`,
          observed: { network: declared },
        } as VerifyOutcome;
    }
    const elsewhere = await probeOtherNetworks(id, kind, ctx.declaredNetworks[0] ?? '', ctx);
    if (elsewhere.length) {
      return {
        result: 'fail',
        detail: `identifier belongs to ${elsewhere.join(', ')}, not the declared network`,
        observed: { foundOn: elsewhere },
      } as VerifyOutcome;
    }
    return { result: 'unknown', detail: 'identifier not found on any configured network' } as VerifyOutcome;
  });
}

// ---------- chain verifiers ----------

/** A SUI coin (gas), with the framework address in short or full form. */
const SUI_COIN_TYPE = /^0x0*2::coin::Coin<0x0*2::sui::SUI>$/;

export const transactionVerifier: Verifier = {
  kind: 'tx',
  verify(ev, ctx) {
    if (ev.kind !== 'tx') throw new Error('wrong evidence kind');
    if (ev.network.startsWith('evm:')) return evmVerifierTx(ev, ctx);
    return guard(async () => {
      const r = await ctx.gateway.getTransaction(ev.digest, call(ctx, ev.network));
      const tx = r.value;
      if (!tx) {
        const elsewhere = await probeOtherNetworks(ev.digest, 'tx', ev.network, ctx);
        if (elsewhere.length)
          return {
            result: 'fail',
            detail: `transaction is on ${elsewhere.join(', ')}, not ${ev.network}`,
            observed: { foundOn: elsewhere },
          };
        return {
          result: 'unknown',
          detail: 'transaction not found: wrong network, not yet indexed, or older than the node retains',
        };
      }
      if (!tx.success)
        return {
          result: 'fail',
          detail: `transaction failed on chain: ${tx.error ?? 'unknown error'}`,
          observed: { checkpoint: tx.checkpoint, epoch: tx.epoch },
        };
      // Architecture section 11: extract created and mutated objects and published packages. A mutated object is
      // one that existed before (`idOperation` none, with an input version), such as the UpgradeCap an upgrade
      // bumps. SUI coins are left out: a gas coin changes on every transaction and would read as drift at once.
      const extracted: Evidence[] = [];
      for (const c of tx.changed) {
        const created = c.idOperation === 'created';
        const mutated = c.idOperation === 'none' && c.inputVersion !== undefined && c.outputKind === 'object';
        if (!created && !mutated) continue;
        if (c.objectType && SUI_COIN_TYPE.test(c.objectType)) continue;
        if (c.outputKind === 'package')
          extracted.push({ kind: 'package', id: normalizeSuiId(c.objectId), network: ev.network });
        else if (c.outputKind === 'object')
          extracted.push({
            kind: 'object',
            id: normalizeSuiId(c.objectId),
            ...(c.outputVersion ? { version: c.outputVersion } : {}),
            network: ev.network,
          });
      }
      return {
        result: 'pass',
        detail: `transaction succeeded${tx.checkpoint ? ` at checkpoint ${tx.checkpoint}` : ''}`,
        observed: {
          checkpoint: tx.checkpoint,
          epoch: tx.epoch,
          timestampMs: tx.timestampMs,
          created: extracted.length,
        },
        extracted,
      };
    });
  },
};

export const objectVerifier: Verifier = {
  kind: 'object',
  verify(ev, ctx) {
    if (ev.kind !== 'object') throw new Error('wrong evidence kind');
    return guard(async () => {
      const id = normalizeSuiId(ev.id);
      const r = await ctx.gateway.getObject(id, call(ctx, ev.network));
      if (!r.value.found) {
        const elsewhere = await probeOtherNetworks(id, 'object', ev.network, ctx);
        if (elsewhere.length)
          return {
            result: 'fail',
            detail: `object is on ${elsewhere.join(', ')}, not ${ev.network}`,
            observed: { foundOn: elsewhere },
          };
        return {
          result: 'fail',
          detail: 'object no longer exists (deleted) or never existed on this network',
          observed: { reason: r.value.reason },
        };
      }
      const o = r.value.object;
      if (ev.version !== undefined && BigInt(o.version) !== BigInt(ev.version)) {
        return {
          result: 'fail',
          detail: `object version changed: cited ${ev.version}, current ${o.version}`,
          observed: { expectedVersion: ev.version, observedVersion: o.version, digest: o.digest },
        };
      }
      return {
        result: 'pass',
        detail: `object exists at version ${o.version}`,
        observed: { version: o.version, digest: o.digest, type: o.type },
      };
    });
  },
};

export const packageVerifier: Verifier = {
  kind: 'package',
  verify(ev, ctx) {
    if (ev.kind !== 'package') throw new Error('wrong evidence kind');
    if (ev.network.startsWith('evm:')) return evmVerifierCode(ev, ctx);
    return guard(async () => {
      const id = normalizeSuiId(ev.id);
      const r = await ctx.gateway.listPackageVersions(id, call(ctx, ev.network));
      const versions = r.value;
      if (!versions || versions.length === 0) {
        const elsewhere = await probeOtherNetworks(id, 'package', ev.network, ctx);
        if (elsewhere.length)
          return {
            result: 'fail',
            detail: `package is on ${elsewhere.join(', ')}, not ${ev.network}`,
            observed: { foundOn: elsewhere },
          };
        return { result: 'unknown', detail: 'package not found on this network' };
      }
      const cited = versions.find((v) => normalizeSuiId(v.packageId) === id);
      const latest = versions.reduce((a, b) => (BigInt(b.version) > BigInt(a.version) ? b : a));
      if (!cited)
        return {
          result: 'unknown',
          detail: 'cited id is not a listed version of this package',
          observed: { latestVersion: latest.version },
        };
      if (BigInt(latest.version) > BigInt(cited.version)) {
        return {
          result: 'fail',
          detail: `package upgraded: cited version ${cited.version}, latest ${latest.version}`,
          observed: {
            citedVersion: cited.version,
            latestVersion: latest.version,
            latestPackageId: latest.packageId,
          },
        };
      }
      return {
        result: 'pass',
        detail: `package is at its latest version (${cited.version})`,
        observed: { version: cited.version },
      };
    });
  },
};

/** Signature drift for a cited function (parameter count), via the Move package service. */
export async function verifyFunctionSignature(
  pkg: string,
  module: string,
  name: string,
  expected: { parameterCount: number },
  network: Network,
  ctx: VerifyContext,
): Promise<VerifyOutcome> {
  return guard(async () => {
    const r = await ctx.gateway.getFunction(normalizeSuiId(pkg), module, name, call(ctx, network));
    if (!r.value) return { result: 'unknown', detail: 'function not found' } as VerifyOutcome;
    return r.value.parameterCount === expected.parameterCount
      ? ({
          result: 'pass',
          detail: 'function signature unchanged',
          observed: { ...r.value },
        } as VerifyOutcome)
      : ({
          result: 'fail',
          detail: `function now takes ${r.value.parameterCount} parameters, expected ${expected.parameterCount}`,
          observed: { ...r.value },
        } as VerifyOutcome);
  });
}

/** Dry-runs a drafted transaction; a failed result becomes a proposed failure-memory draft. */
export async function simulateToFailure(
  tx: { bcsBase64: string },
  network: Network,
  ctx: VerifyContext,
  label = 'drafted transaction',
): Promise<VerifyOutcome> {
  return guard(async () => {
    const r = await ctx.gateway.simulate(tx, call(ctx, network));
    if (r.value.success)
      return {
        result: 'pass',
        detail: 'simulation succeeded',
        observed: { gasUsed: r.value.gasUsed },
      } as VerifyOutcome;
    const e = r.value.error;
    const text = `Simulation of ${label} failed on ${network}: ${e?.description ?? 'unknown error'}${e?.kind ? ` (${e.kind})` : ''}${e?.command ? ` at command ${e.command}` : ''}.`;
    return {
      result: 'fail',
      detail: text,
      observed: { ...e },
      failureDraft: { type: 'failure', text, evidence: [] },
    } as VerifyOutcome;
  });
}

// ---------- repository evidence (computed client-side) ----------

export const repositoryVerifier: Verifier = {
  kind: 'file',
  async verify(ev, ctx) {
    if (ev.kind !== 'file') throw new Error('wrong evidence kind');
    const r = ctx.repo?.[ev.path];
    if (!r) return { result: 'unknown', detail: 'no repository check result was supplied for this file' };
    if (!r.exists) return { result: 'fail', detail: `file no longer exists: ${ev.path}`, observed: { ...r } };
    if (r.changed)
      return {
        result: 'fail',
        detail: `file changed since ${ev.commit ?? 'the cited commit'}: flag for review`,
        observed: { ...r },
      };
    return { result: 'pass', detail: 'file unchanged since the cited commit', observed: { ...r } };
  },
};

// ---------- EVM (minimal) ----------

const evmChain = (network: Network) => network.replace(/^evm:/, '');

async function evmVerifierTx(
  ev: Extract<Evidence, { kind: 'tx' }>,
  ctx: VerifyContext,
): Promise<VerifyOutcome> {
  return guard(async () => {
    const rcpt = (await ctx.gateway.evmRpc(
      evmChain(ev.network),
      'eth_getTransactionReceipt',
      [ev.digest],
      ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {},
    )) as { status?: string } | null;
    if (!rcpt) return { result: 'unknown', detail: 'receipt not found (pending, wrong chain, or pruned)' };
    return rcpt.status === '0x1'
      ? { result: 'pass', detail: 'transaction succeeded' }
      : { result: 'fail', detail: 'transaction reverted', observed: { status: rcpt.status } };
  });
}

async function evmVerifierCode(
  ev: Extract<Evidence, { kind: 'package' }>,
  ctx: VerifyContext,
): Promise<VerifyOutcome> {
  return guard(async () => {
    const code = (await ctx.gateway.evmRpc(
      evmChain(ev.network),
      'eth_getCode',
      [ev.id, 'latest'],
      ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {},
    )) as string;
    return code && code !== '0x'
      ? { result: 'pass', detail: 'contract code present' }
      : { result: 'fail', detail: 'no contract code at address' };
  });
}

// ---------- Walrus health (expiry cross-check; field names ASSUMED, A11) ----------

export interface WalrusHealthInput {
  /** MemWalAccount object id. */
  accountId?: string;
  network: Network;
  items: { memoryId: string; blobId: string; endEpoch?: number; status?: string }[];
  marginEpochs?: number;
  /** Delegates observed (read interface / account object); compared with the expected set. */
  observedDelegates?: string[];
  expectedDelegates?: string[];
}

export interface WalrusHealthOutcome extends VerifyOutcome {
  expiring: string[];
  expired: string[];
  inconsistent: string[];
  unexpectedDelegates: string[];
}

export async function verifyWalrusHealth(
  input: WalrusHealthInput,
  ctx: VerifyContext,
): Promise<WalrusHealthOutcome> {
  const empty = {
    expiring: [] as string[],
    expired: [] as string[],
    inconsistent: [] as string[],
    unexpectedDelegates: [] as string[],
  };
  try {
    const ep = await ctx.gateway.getEpoch(call(ctx, input.network));
    const current = Number(ep.value.epoch);
    const margin = input.marginEpochs ?? 2;
    const out = { ...empty };
    for (const it of input.items) {
      if (it.endEpoch === undefined) continue;
      const remaining = it.endEpoch - current;
      if (remaining <= 0) out.expired.push(it.memoryId);
      else if (remaining < margin) out.expiring.push(it.memoryId);
      if (remaining <= 0 && it.status === 'active') out.inconsistent.push(it.memoryId);
    }
    if (input.expectedDelegates && input.observedDelegates) {
      out.unexpectedDelegates = input.observedDelegates.filter((d) => !input.expectedDelegates!.includes(d));
    }
    let accountFound: boolean | undefined;
    if (input.accountId) {
      const acct = await ctx.gateway.getObject(normalizeSuiId(input.accountId), call(ctx, input.network));
      accountFound = acct.value.found;
    }
    const bad =
      out.expired.length ||
      out.unexpectedDelegates.length ||
      out.inconsistent.length ||
      accountFound === false;
    const warn = out.expiring.length > 0;
    return {
      ...out,
      result: bad ? 'fail' : 'pass',
      detail: bad
        ? `storage health problem: ${out.expired.length} expired, ${out.unexpectedDelegates.length} unexpected delegates${accountFound === false ? ', account object not found' : ''}`
        : warn
          ? `${out.expiring.length} memories are inside the expiry margin`
          : 'storage healthy',
      observed: { currentEpoch: current, accountFound, expiring: out.expiring.length },
    };
  } catch (e) {
    return { ...empty, ...degradedOutcome(e) };
  }
}

// ---------- registry ----------

const REGISTRY: Verifier[] = [transactionVerifier, objectVerifier, packageVerifier, repositoryVerifier];

export async function verifyEvidence(ev: Evidence, ctx: VerifyContext): Promise<VerifyOutcome> {
  const v = REGISTRY.find((x) => x.kind === ev.kind);
  if (!v) return { result: 'unknown', detail: `no verifier for ${ev.kind} evidence (not checkable)` };
  return guard(() => v.verify(ev, ctx));
}

export function registerVerifier(v: Verifier): void {
  const i = REGISTRY.findIndex((x) => x.kind === v.kind);
  if (i >= 0) REGISTRY[i] = v;
  else REGISTRY.push(v);
}

export type { Result };
