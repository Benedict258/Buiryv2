import { ChainError, type EpochInfo, type ObjectResult, type TxInfo, type ChangedObject } from '../types.js';
import type { ChainBackend, MethodName } from './backend.js';

export interface JsonRpcOptions {
  url: string;
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Header carrying the key. Tatum documents an API key header; name kept configurable (A8). */
  keyHeader?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const SUPPORTED: MethodName[] = [
  'getTransaction',
  'getObject',
  'batchGetObjects',
  'simulate',
  'getEpoch',
  'getServiceInfo',
  'listOwnedObjects',
  'getBalance',
  'lookupName',
  'reverseLookupName',
];

export function mapHttpStatus(status: number, msg: string): ChainError {
  if (status === 401 || status === 403)
    return new ChainError('config', `gateway rejected the API key: ${msg}`, status);
  if (status === 429) return new ChainError('rate_limited', msg, status);
  if (status === 404) return new ChainError('not_found', msg, status);
  if (status >= 500) return new ChainError('unavailable', msg, status);
  return new ChainError('invalid', msg, status);
}

/**
 * Mainnet fallback transport. Sui deprecated JSON-RPC in favour of gRPC, so this covers the subset
 * needed for verification. Package upgrade history and Move datatype lookups are gRPC-only (unsupported here).
 */
export class JsonRpcBackend implements ChainBackend {
  readonly transport = 'jsonrpc' as const;
  private seq = 0;
  private readonly f: typeof fetch;

  constructor(private readonly o: JsonRpcOptions) {
    this.f = o.fetch ?? fetch;
  }

  supports(m: MethodName): boolean {
    return SUPPORTED.includes(m);
  }

  private async rpc(method: string, params: unknown[]): Promise<Json> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 10_000);
    let res: Response;
    try {
      res = await this.f(this.o.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [this.o.keyHeader ?? 'x-api-key']: this.o.apiKey },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.seq, method, params }),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new ChainError(
        'unavailable',
        e instanceof Error && e.name === 'AbortError' ? 'timeout' : `network: ${(e as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (!res.ok) throw mapHttpStatus(res.status, text.slice(0, 200));
    let body: Json;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ChainError('unavailable', 'gateway returned non-JSON');
    }
    if (body.error) {
      const msg = String(body.error.message ?? 'rpc error');
      if (/not\s*found|does not exist|could not find/i.test(msg))
        throw new ChainError('not_found', msg, body.error.code);
      if (/invalid|malformed/i.test(msg)) throw new ChainError('invalid', msg, body.error.code);
      throw new ChainError('unknown', msg, body.error.code);
    }
    return body.result;
  }

  private objectFrom(d: Json, id: string): ObjectResult {
    if (d?.error) {
      const code = d.error.code as string | undefined;
      return { found: false, id, reason: code === 'deleted' ? 'deleted' : (code ?? 'notExists') };
    }
    const data = d?.data;
    if (!data) return { found: false, id, reason: 'not found' };
    const owner = data.owner;
    const ownerOut =
      owner === 'Immutable'
        ? { kind: 'immutable' }
        : owner?.AddressOwner
          ? { kind: 'address', address: owner.AddressOwner }
          : owner?.ObjectOwner
            ? { kind: 'object', address: owner.ObjectOwner }
            : owner?.Shared
              ? { kind: 'shared' }
              : undefined;
    return {
      found: true,
      object: {
        id: data.objectId,
        version: String(data.version),
        digest: data.digest,
        ...(data.type ? { type: data.type } : {}),
        ...(ownerOut ? { owner: ownerOut } : {}),
      },
    };
  }

  async getObject(id: string, version?: string): Promise<ObjectResult> {
    const opts = { showType: true, showOwner: true };
    if (version !== undefined) {
      const r = await this.rpc('sui_tryGetPastObject', [id, Number(version), opts]);
      if (r.status === 'VersionFound') return this.objectFrom({ data: r.details }, id);
      return { found: false, id, reason: String(r.status ?? 'not found') };
    }
    return this.objectFrom(await this.rpc('sui_getObject', [id, opts]), id);
  }

  async batchGetObjects(ids: string[]): Promise<ObjectResult[]> {
    const r: Json[] = await this.rpc('sui_multiGetObjects', [ids, { showType: true, showOwner: true }]);
    return ids.map((id, i) => this.objectFrom(r[i], id));
  }

  async getTransaction(digest: string): Promise<TxInfo | null> {
    let r: Json;
    try {
      r = await this.rpc('sui_getTransactionBlock', [digest, { showEffects: true, showObjectChanges: true }]);
    } catch (e) {
      if (e instanceof ChainError && e.kind === 'not_found') return null;
      throw e;
    }
    const st = r.effects?.status;
    const changed: ChangedObject[] = (r.objectChanges ?? []).map((c: Json) => ({
      objectId: c.objectId ?? c.packageId,
      idOperation:
        c.type === 'created' || c.type === 'published'
          ? 'created'
          : c.type === 'deleted'
            ? 'deleted'
            : 'none',
      outputKind: c.type === 'published' ? 'package' : c.type === 'deleted' ? 'deleted' : 'object',
      ...(c.previousVersion !== undefined ? { inputVersion: String(c.previousVersion) } : {}),
      ...(c.version !== undefined ? { outputVersion: String(c.version) } : {}),
      ...(c.digest ? { outputDigest: c.digest } : {}),
      ...(c.objectType ? { objectType: c.objectType } : {}),
    }));
    return {
      digest: r.digest,
      success: st?.status === 'success',
      ...(st?.status === 'failure' ? { error: String(st.error ?? 'execution failed') } : {}),
      ...(r.effects?.executedEpoch !== undefined ? { epoch: String(r.effects.executedEpoch) } : {}),
      ...(r.checkpoint !== undefined ? { checkpoint: String(r.checkpoint) } : {}),
      ...(r.timestampMs !== undefined ? { timestampMs: Number(r.timestampMs) } : {}),
      changed,
    };
  }

  async listPackageVersions(): Promise<null> {
    throw new ChainError('unsupported', 'package version history is gRPC-only');
  }
  async getFunction(): Promise<null> {
    throw new ChainError('unsupported', 'getFunction is gRPC-only here');
  }
  async getDatatype(): Promise<null> {
    throw new ChainError('unsupported', 'getDatatype is gRPC-only here');
  }

  async simulate(tx: { bcsBase64: string }) {
    const r = await this.rpc('sui_dryRunTransactionBlock', [tx.bcsBase64]);
    const st = r.effects?.status;
    if (st?.status === 'failure')
      return { success: false, error: { description: String(st.error ?? 'simulation failed') } };
    return { success: true };
  }

  async getServiceInfo(): Promise<EpochInfo> {
    const [chainId, state] = await Promise.all([
      this.rpc('sui_getChainIdentifier', []),
      this.rpc('suix_getLatestSuiSystemState', []),
    ]);
    return {
      epoch: String(state.epoch),
      chainId: String(chainId),
      ...(state.epochStartTimestampMs ? { startMs: Number(state.epochStartTimestampMs) } : {}),
    };
  }

  async getEpoch(epoch?: string): Promise<EpochInfo> {
    if (epoch !== undefined) throw new ChainError('unsupported', 'historical epochs are gRPC-only here');
    return this.getServiceInfo();
  }

  async listOwnedObjects(owner: string, objectType?: string) {
    const out: { id: string; version: string; type: string }[] = [];
    let cursor: string | null = null;
    do {
      const r: Json = await this.rpc('suix_getOwnedObjects', [
        owner,
        { filter: objectType ? { StructType: objectType } : null, options: { showType: true } },
        cursor,
        50,
      ]);
      for (const x of r.data ?? [])
        if (x.data)
          out.push({ id: x.data.objectId, version: String(x.data.version), type: x.data.type ?? '' });
      cursor = r.hasNextPage ? r.nextCursor : null;
    } while (cursor);
    return out;
  }

  async getBalance(owner: string, coinType: string) {
    const r = await this.rpc('suix_getBalance', [owner, coinType]);
    return { balance: String(r.totalBalance ?? '0') };
  }

  async lookupName(name: string) {
    const r = await this.rpc('suix_resolveNameServiceAddress', [name]);
    return r ? { name, targetAddress: String(r) } : null;
  }

  async reverseLookupName(address: string) {
    const r = await this.rpc('suix_resolveNameServiceNames', [address]);
    const first = r?.data?.[0];
    return first ? { name: String(first), targetAddress: address } : null;
  }

  close(): void {}
}
