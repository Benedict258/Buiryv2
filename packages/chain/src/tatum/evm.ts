import { ChainError } from '../types.js';

export interface EvmChainConfig {
  url: string;
  apiKey: string;
  keyHeader?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** Minimal EVM JSON-RPC client (eth_getCode, eth_getTransactionReceipt, ...). Used only through the gateway. */
export class EvmRpc {
  private seq = 0;
  constructor(
    private readonly cfg: EvmChainConfig,
    private readonly f: typeof fetch = fetch,
  ) {}

  async call(method: string, params: unknown[]): Promise<Json> {
    let res: Response;
    try {
      res = await this.f(this.cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [this.cfg.keyHeader ?? 'x-api-key']: this.cfg.apiKey },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.seq, method, params }),
      });
    } catch (e) {
      throw new ChainError('unavailable', `network: ${(e as Error).message}`);
    }
    if (res.status === 401 || res.status === 403)
      throw new ChainError('config', 'gateway rejected the API key', res.status);
    if (res.status === 429) throw new ChainError('rate_limited', 'rate limited', 429);
    if (!res.ok)
      throw new ChainError(res.status >= 500 ? 'unavailable' : 'invalid', `http ${res.status}`, res.status);
    const body: Json = await res.json().catch(() => ({}));
    if (body.error)
      throw new ChainError('unknown', String(body.error.message ?? 'rpc error'), body.error.code);
    return body.result;
  }
}
