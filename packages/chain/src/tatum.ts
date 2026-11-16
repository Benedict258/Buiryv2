/**
 * The single Tatum gateway (architecture principle 3). This file and ./tatum/** are the only code that
 * imports a chain client or reads the Tatum API key. Everything else gets typed data plus provenance.
 */
import {
  ChainError,
  type DatatypeInfo,
  type EpochInfo,
  type FunctionInfo,
  type NameRecord,
  type Network,
  type ObjectResult,
  type OwnedObject,
  type PackageVersion,
  type Provenance,
  type SimulationResult,
  type Transport,
  type TxInfo,
} from './types.js';
import type { ChainBackend, MethodName } from './tatum/backend.js';
import { POLICY, TtlCache, type CachePolicy } from './tatum/cache.js';
import { CreditBudget, TokenBucket } from './tatum/limits.js';
import { GrpcBackend } from './tatum/grpc.js';
import { JsonRpcBackend } from './tatum/jsonrpc.js';
import { EvmRpc, type EvmChainConfig } from './tatum/evm.js';

export type { ChainBackend, MethodName };

export interface CallRecord {
  at: number;
  method: string;
  transport: Transport | 'cache';
  network: Network;
  latencyMs: number;
  status: 'ok' | 'not_found' | 'error' | 'cache_hit' | 'budget';
  errorKind?: string;
  creditEstimate: number;
  workspaceId?: string;
  /** Set when this attempt ran after another transport failed. */
  fallbackFrom?: Transport;
}

export interface CallSink {
  record(r: CallRecord): void | Promise<void>;
}

export interface GatewayStatus {
  state: 'ok' | 'degraded';
  consecutiveFailures: number;
  lastSuccessAt?: number;
  calls: number;
  errorRate: number;
  latencyP50: number;
  latencyP95: number;
  transportMix: Record<Transport | 'cache', number>;
  creditsEstimated: number;
}

export interface CallContext {
  workspaceId?: string;
  /**
   * Revalidate on demand (architecture section 11): skip cached and in-flight reads and ask the chain. Used for
   * explicit verification, so a check right after an upgrade cannot return the version list from before it.
   */
  fresh?: boolean;
}

export interface Result<T> {
  value: T;
  prov: Provenance;
}

export interface GatewayOptions {
  /** Ordered per network: first entry is primary (gRPC); a later JSON-RPC entry is an opt-in fallback (A8). */
  backends: Record<Network, ChainBackend[]>;
  defaultNetwork: Network;
  evm?: Record<string, EvmChainConfig>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Free plan default: 3 requests per second. */
  requestsPerSecond?: number;
  /** gRPC calls documented at 2 credits; JSON-RPC cost assumed equal (A9). */
  creditsPerCall?: number;
  workspaceCredits?: { limit: number; periodMs: number };
  sink?: CallSink;
  maxRetries?: number;
  backoffBaseMs?: number;
  /** Consecutive transport failures before the gateway reports degraded. */
  degradedAfter?: number;
  evmFetch?: typeof fetch;
  batchSize?: number;
}

const stripNet = (n: Network) => n;

export class TatumGateway {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly cache: TtlCache;
  private readonly bucket: TokenBucket;
  private readonly budget?: CreditBudget;
  private readonly credits: number;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly recent: CallRecord[] = [];
  private failures = 0;
  private lastSuccessAt: number | undefined;
  private readonly evm = new Map<string, EvmRpc>();

  constructor(private readonly o: GatewayOptions) {
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.cache = new TtlCache(this.now);
    this.bucket = new TokenBucket(o.requestsPerSecond ?? 3, this.now, this.sleep);
    this.credits = o.creditsPerCall ?? 2;
    if (o.workspaceCredits)
      this.budget = new CreditBudget(o.workspaceCredits.limit, o.workspaceCredits.periodMs, this.now);
    for (const [chain, cfg] of Object.entries(o.evm ?? {})) this.evm.set(chain, new EvmRpc(cfg, o.evmFetch));
  }

  /** Attach (or replace) the telemetry sink after construction, e.g. once the database exists. */
  setSink(sink: CallSink): void {
    this.o.sink = sink;
  }

  get networks(): Network[] {
    return Object.keys(this.o.backends);
  }
  get defaultNetwork(): Network {
    return this.o.defaultNetwork;
  }

  // ---------- telemetry ----------

  private async emit(r: CallRecord): Promise<void> {
    this.recent.push(r);
    if (this.recent.length > 500) this.recent.shift();
    await this.o.sink?.record(r);
  }

  status(): GatewayStatus {
    const calls = this.recent.filter((r) => r.status !== 'cache_hit');
    const lat = calls.map((r) => r.latencyMs).sort((a, b) => a - b);
    const pick = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))]! : 0);
    const mix: Record<Transport | 'cache', number> = { grpc: 0, jsonrpc: 0, cache: 0 };
    for (const r of this.recent) mix[r.transport]++;
    return {
      state: this.failures >= (this.o.degradedAfter ?? 3) ? 'degraded' : 'ok',
      consecutiveFailures: this.failures,
      ...(this.lastSuccessAt !== undefined ? { lastSuccessAt: this.lastSuccessAt } : {}),
      calls: calls.length,
      errorRate: calls.length ? calls.filter((r) => r.status === 'error').length / calls.length : 0,
      latencyP50: pick(0.5),
      latencyP95: pick(0.95),
      transportMix: mix,
      creditsEstimated: this.recent.reduce((a, r) => a + r.creditEstimate, 0),
    };
  }

  creditUsage(workspaceId: string): { used: number; limit: number } | null {
    return this.budget ? this.budget.usage(workspaceId) : null;
  }

  // ---------- execution core ----------

  private async attempt<T>(
    backend: ChainBackend,
    method: MethodName,
    network: Network,
    ctx: CallContext,
    fn: (b: ChainBackend) => Promise<T>,
    fallbackFrom?: Transport,
  ): Promise<{ value: T; latencyMs: number }> {
    const max = this.o.maxRetries ?? 2;
    let lastErr: ChainError | undefined;
    for (let i = 0; i <= max; i++) {
      await this.bucket.acquire();
      if (ctx.workspaceId && this.budget) {
        try {
          this.budget.charge(ctx.workspaceId, this.credits);
        } catch (e) {
          await this.emit({
            at: this.now(),
            method,
            transport: backend.transport,
            network,
            latencyMs: 0,
            status: 'budget',
            creditEstimate: 0,
            workspaceId: ctx.workspaceId,
          });
          throw e;
        }
      }
      const t0 = this.now();
      try {
        const value = await fn(backend);
        const latencyMs = this.now() - t0;
        this.failures = 0;
        this.lastSuccessAt = this.now();
        await this.emit({
          at: t0,
          method,
          transport: backend.transport,
          network,
          latencyMs,
          status: 'ok',
          creditEstimate: this.credits,
          ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
          ...(fallbackFrom ? { fallbackFrom } : {}),
        });
        return { value, latencyMs };
      } catch (e) {
        const err = e instanceof ChainError ? e : new ChainError('unknown', (e as Error).message);
        lastErr = err;
        const latencyMs = this.now() - t0;
        if (err.kind === 'unavailable' || err.kind === 'rate_limited') this.failures++;
        await this.emit({
          at: t0,
          method,
          transport: backend.transport,
          network,
          latencyMs,
          status: err.kind === 'not_found' ? 'not_found' : 'error',
          errorKind: err.kind,
          creditEstimate: this.credits,
          ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
          ...(fallbackFrom ? { fallbackFrom } : {}),
        });
        if (!err.retryable || i === max) throw err;
        await this.sleep((this.o.backoffBaseMs ?? 250) * 2 ** i);
      }
    }
    throw lastErr ?? new ChainError('unknown', 'exhausted');
  }

  private async run<T>(
    method: MethodName,
    network: Network,
    ctx: CallContext,
    fn: (b: ChainBackend) => Promise<T>,
  ): Promise<{ value: T; transport: Transport; latencyMs: number }> {
    const backends = (this.o.backends[network] ?? []).filter((b) => b.supports(method));
    if (backends.length === 0)
      throw new ChainError('unsupported', `no transport serves ${method} on ${network}`);
    let prev: ChainError | undefined;
    let prevTransport: Transport | undefined;
    for (const b of backends) {
      try {
        const r = await this.attempt(b, method, network, ctx, fn, prevTransport);
        return { ...r, transport: b.transport };
      } catch (e) {
        const err = e as ChainError;
        // A bad key or an exhausted budget will not be fixed by another transport.
        if (err.kind === 'config' || err.kind === 'budget_exceeded' || err.kind === 'invalid') throw err;
        prev = err;
        prevTransport = b.transport;
      }
    }
    throw prev ?? new ChainError('unknown', 'no transport answered');
  }

  /** Cached, de-duplicated call. `ttl` null disables caching; absent results use the negative policy. */
  private async cached<T>(
    method: MethodName,
    network: Network,
    key: string | null,
    policyFor: (v: T) => CachePolicy | null,
    ctx: CallContext,
    fn: (b: ChainBackend) => Promise<T>,
  ): Promise<Result<T>> {
    const ck = key ? `${network}|${key}` : null;
    if (ck && !ctx.fresh) {
      const hit = this.cache.get<T>(ck);
      if (hit !== undefined) {
        await this.emit({
          at: this.now(),
          method,
          transport: 'cache',
          network,
          latencyMs: 0,
          status: 'cache_hit',
          creditEstimate: 0,
          ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
        });
        return {
          value: hit,
          prov: { transport: 'cache', network: stripNet(network), latencyMs: 0, cached: true },
        };
      }
      const pending = this.inflight.get(ck) as Promise<Result<T>> | undefined;
      if (pending) return pending;
    }
    const p = (async (): Promise<Result<T>> => {
      const r = await this.run(method, network, ctx, fn);
      const policy = policyFor(r.value);
      if (ck && policy) this.cache.set(ck, r.value, policy);
      return {
        value: r.value,
        prov: { transport: r.transport, network, latencyMs: r.latencyMs, cached: false },
      };
    })();
    if (ck) {
      this.inflight.set(ck, p);
      void p.finally(() => this.inflight.delete(ck)).catch(() => {});
    }
    return p;
  }

  private net(n?: Network): Network {
    const network = n ?? this.o.defaultNetwork;
    if (!this.o.backends[network]) throw new ChainError('invalid', `network ${network} is not configured`);
    return network;
  }

  // ---------- typed API ----------

  async getTransaction(
    digest: string,
    o: { network?: Network } & CallContext = {},
  ): Promise<Result<TxInfo | null>> {
    const network = this.net(o.network);
    return this.cached(
      'getTransaction',
      network,
      `tx:${digest}`,
      (v) => (v ? POLICY.immutable : POLICY.negative),
      o,
      (b) => b.getTransaction(digest),
    );
  }

  async getObject(
    id: string,
    o: { network?: Network; version?: string } & CallContext = {},
  ): Promise<Result<ObjectResult>> {
    const network = this.net(o.network);
    return this.cached(
      'getObject',
      network,
      `obj:${id}:${o.version ?? 'latest'}`,
      (v) => (!v.found ? POLICY.negative : o.version !== undefined ? POLICY.immutable : POLICY.current),
      o,
      (b) => b.getObject(id, o.version),
    );
  }

  /** Batches uncached ids into BatchGetObjects calls; cached ids are served locally. */
  async batchGetObjects(
    ids: string[],
    o: { network?: Network } & CallContext = {},
  ): Promise<Result<ObjectResult[]>> {
    const network = this.net(o.network);
    const unique = [...new Set(ids)];
    const found = new Map<string, ObjectResult>();
    const missing: string[] = [];
    for (const id of unique) {
      const hit = this.cache.get<ObjectResult>(`${network}|obj:${id}:latest`);
      if (hit) found.set(id, hit);
      else missing.push(id);
    }
    let transport: Provenance['transport'] = 'cache';
    let latencyMs = 0;
    const size = this.o.batchSize ?? 50;
    for (let i = 0; i < missing.length; i += size) {
      const chunk = missing.slice(i, i + size);
      const r = await this.run('batchGetObjects', network, o, (b) => b.batchGetObjects(chunk));
      transport = r.transport;
      latencyMs += r.latencyMs;
      chunk.forEach((id, j) => {
        const v = r.value[j]!;
        found.set(id, v);
        this.cache.set(`${network}|obj:${id}:latest`, v, v.found ? POLICY.current : POLICY.negative);
      });
    }
    return {
      value: ids.map((id) => found.get(id)!),
      prov: { transport, network, latencyMs, cached: missing.length === 0 },
    };
  }

  async listPackageVersions(
    packageId: string,
    o: { network?: Network } & CallContext = {},
  ): Promise<Result<PackageVersion[] | null>> {
    const network = this.net(o.network);
    return this.cached(
      'listPackageVersions',
      network,
      `pkgv:${packageId}`,
      (v) => (v ? POLICY.current : POLICY.negative),
      o,
      (b) => b.listPackageVersions(packageId),
    );
  }

  async getFunction(
    packageId: string,
    module: string,
    name: string,
    o: { network?: Network } & CallContext = {},
  ): Promise<Result<FunctionInfo | null>> {
    const network = this.net(o.network);
    return this.cached(
      'getFunction',
      network,
      `fn:${packageId}:${module}:${name}`,
      (v) => (v ? POLICY.immutable : POLICY.negative),
      o,
      (b) => b.getFunction(packageId, module, name),
    );
  }

  async getDatatype(
    packageId: string,
    module: string,
    name: string,
    o: { network?: Network } & CallContext = {},
  ): Promise<Result<DatatypeInfo | null>> {
    const network = this.net(o.network);
    return this.cached(
      'getDatatype',
      network,
      `dt:${packageId}:${module}:${name}`,
      (v) => (v ? POLICY.immutable : POLICY.negative),
      o,
      (b) => b.getDatatype(packageId, module, name),
    );
  }

  async simulate(
    tx: { bcsBase64: string },
    o: { network?: Network } & CallContext = {},
  ): Promise<Result<SimulationResult>> {
    return this.cached(
      'simulate',
      this.net(o.network),
      null,
      () => null,
      o,
      (b) => b.simulate(tx),
    );
  }

  async getServiceInfo(o: { network?: Network } & CallContext = {}): Promise<Result<EpochInfo>> {
    return this.cached(
      'getServiceInfo',
      this.net(o.network),
      'svcinfo',
      () => POLICY.current,
      o,
      (b) => b.getServiceInfo(),
    );
  }

  async getEpoch(o: { network?: Network; epoch?: string } & CallContext = {}): Promise<Result<EpochInfo>> {
    const network = this.net(o.network);
    return this.cached(
      'getEpoch',
      network,
      `epoch:${o.epoch ?? 'current'}`,
      () => (o.epoch ? POLICY.immutable : POLICY.current),
      o,
      (b) => b.getEpoch(o.epoch),
    );
  }

  async listOwnedObjects(
    owner: string,
    objectType: string | undefined,
    o: { network?: Network } & CallContext = {},
  ): Promise<Result<OwnedObject[]>> {
    return this.cached(
      'listOwnedObjects',
      this.net(o.network),
      `owned:${owner}:${objectType ?? ''}`,
      () => POLICY.current,
      o,
      (b) => b.listOwnedObjects(owner, objectType),
    );
  }

  async getBalance(
    owner: string,
    coinType: string,
    o: { network?: Network } & CallContext = {},
  ): Promise<Result<{ balance: string }>> {
    return this.cached(
      'getBalance',
      this.net(o.network),
      `bal:${owner}:${coinType}`,
      () => POLICY.current,
      o,
      (b) => b.getBalance(owner, coinType),
    );
  }

  async lookupName(
    name: string,
    o: { network?: Network } & CallContext = {},
  ): Promise<Result<NameRecord | null>> {
    return this.cached(
      'lookupName',
      this.net(o.network),
      `name:${name}`,
      () => POLICY.names,
      o,
      (b) => b.lookupName(name),
    );
  }

  async reverseLookupName(
    address: string,
    o: { network?: Network } & CallContext = {},
  ): Promise<Result<NameRecord | null>> {
    return this.cached(
      'reverseLookupName',
      this.net(o.network),
      `rname:${address}`,
      () => POLICY.names,
      o,
      (b) => b.reverseLookupName(address),
    );
  }

  /** EVM JSON-RPC through the same limiter, budget and telemetry (minimal EVM verifier). */
  async evmRpc(chain: string, method: string, params: unknown[], ctx: CallContext = {}): Promise<unknown> {
    const client = this.evm.get(chain);
    if (!client) throw new ChainError('invalid', `EVM chain ${chain} is not configured`);
    await this.bucket.acquire();
    if (ctx.workspaceId && this.budget) this.budget.charge(ctx.workspaceId, this.credits);
    const t0 = this.now();
    try {
      const v = await client.call(method, params);
      this.failures = 0;
      this.lastSuccessAt = this.now();
      await this.emit({
        at: t0,
        method: `evm:${method}`,
        transport: 'jsonrpc',
        network: `evm:${chain}`,
        latencyMs: this.now() - t0,
        status: 'ok',
        creditEstimate: this.credits,
      });
      return v;
    } catch (e) {
      const err = e instanceof ChainError ? e : new ChainError('unknown', (e as Error).message);
      if (err.retryable) this.failures++;
      await this.emit({
        at: t0,
        method: `evm:${method}`,
        transport: 'jsonrpc',
        network: `evm:${chain}`,
        latencyMs: this.now() - t0,
        status: 'error',
        errorKind: err.kind,
        creditEstimate: this.credits,
      });
      throw err;
    }
  }

  close(): void {
    for (const list of Object.values(this.o.backends)) for (const b of list) b.close();
  }
}

// ---------- construction from environment (the only place the key is read) ----------

export interface EnvLike {
  [k: string]: string | undefined;
}

/** Network name → `sui:<name>` used throughout Buiry. */
export function suiNetwork(name: string): Network {
  return name.startsWith('sui:') ? name : `sui:${name}`;
}

/**
 * Builds a gateway from TATUM_* variables. Endpoints are never defaulted: they come from Tatum's docs
 * (LOCAL_CHECKS L-T0) so no hostname is invented here.
 *   TATUM_API_KEY, TATUM_NETWORK (mainnet|testnet|devnet), TATUM_GRPC_ENDPOINT (host:port), TATUM_FREE_RPS
 * The gateway is gRPC only. Tatum does not serve Sui JSON-RPC (A8: live 404), so the JSON-RPC backend is
 * added only when TATUM_JSONRPC_URL is explicitly set. Leave it unset.
 */
export function createGatewayFromEnv(env: EnvLike, extra: Partial<GatewayOptions> = {}): TatumGateway {
  const apiKey = env.TATUM_API_KEY;
  if (!apiKey) throw new ChainError('config', 'TATUM_API_KEY is not set');
  const network = suiNetwork(env.TATUM_NETWORK ?? 'mainnet');
  const list: ChainBackend[] = [];
  if (env.TATUM_GRPC_ENDPOINT) list.push(new GrpcBackend({ endpoint: env.TATUM_GRPC_ENDPOINT, apiKey }));
  if (env.TATUM_JSONRPC_URL) list.push(new JsonRpcBackend({ url: env.TATUM_JSONRPC_URL, apiKey }));
  if (list.length === 0) throw new ChainError('config', 'TATUM_GRPC_ENDPOINT is not set');
  return new TatumGateway({
    backends: { [network]: list },
    defaultNetwork: network,
    ...(env.TATUM_FREE_RPS ? { requestsPerSecond: Number(env.TATUM_FREE_RPS) } : {}),
    ...extra,
  });
}

/** Like createGatewayFromEnv, but returns undefined when no Tatum key is configured (keeps the key read inside this module). */
export function createGatewayIfConfigured(
  env: EnvLike,
  extra: Partial<GatewayOptions> = {},
): TatumGateway | undefined {
  return env.TATUM_API_KEY ? createGatewayFromEnv(env, extra) : undefined;
}
