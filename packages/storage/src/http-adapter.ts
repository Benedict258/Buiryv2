import {
  MAX_BULK,
  RelayerError,
  type JobStatus,
  type MemoryListPage,
  type RecallRequest,
  type RecalledMemory,
  type RelayerHealth,
  type RelayerVersion,
  type WalrusMemoryAdapter,
  type WriteState,
} from './adapter.js';
import { canonicalRequest, type Signer } from './signer.js';

/** Endpoint paths are ASSUMED (A14); override per relayer without touching callers. */
export interface RelayerPaths {
  remember: string;
  rememberBulk: string;
  job: (id: string) => string;
  recall: string;
  analyze: string;
  restore: string;
  health: string;
  version: string;
  list: string;
  forget: string;
}

export const DEFAULT_PATHS: RelayerPaths = {
  remember: '/remember',
  rememberBulk: '/remember/bulk',
  job: (id) => `/jobs/${encodeURIComponent(id)}`,
  recall: '/recall',
  analyze: '/analyze',
  restore: '/restore',
  health: '/health',
  version: '/version',
  list: '/memories',
  forget: '/forget',
};

/** Header names are ASSUMED (A13). */
export interface AuthHeaders {
  account: string;
  publicKey: string;
  timestamp: string;
  signature: string;
}
export const DEFAULT_AUTH_HEADERS: AuthHeaders = {
  account: 'x-account-id',
  publicKey: 'x-delegate-key',
  timestamp: 'x-timestamp',
  signature: 'x-signature',
};

export interface HttpAdapterOptions {
  baseUrl: string;
  accountId: string;
  signer: Signer;
  fetch?: typeof fetch;
  now?: () => number;
  paths?: RelayerPaths;
  authHeaders?: AuthHeaders;
  timeoutMs?: number;
  /** Relayer versions this build supports (major.minor prefixes, e.g. "1."). Empty = accept any. */
  supportedVersionPrefixes?: string[];
}

type Json = Record<string, unknown>;

export class HttpWalrusAdapter implements WalrusMemoryAdapter {
  private readonly f: typeof fetch;
  private readonly now: () => number;
  private readonly paths: RelayerPaths;
  private readonly hdr: AuthHeaders;
  private readonly base: string;

  constructor(private readonly o: HttpAdapterOptions) {
    this.f = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
    this.paths = o.paths ?? DEFAULT_PATHS;
    this.hdr = o.authHeaders ?? DEFAULT_AUTH_HEADERS;
    this.base = o.baseUrl.replace(/\/+$/, '');
  }

  private async call(method: 'GET' | 'POST', path: string, body?: Json, signed = true): Promise<Json> {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (signed) {
      const ts = String(Math.floor(this.now() / 1000));
      const sig = await this.o.signer.sign(
        new TextEncoder().encode(canonicalRequest(ts, method, path, payload)),
      );
      headers[this.hdr.account] = this.o.accountId;
      headers[this.hdr.publicKey] = this.o.signer.publicKeyHex;
      headers[this.hdr.timestamp] = ts;
      headers[this.hdr.signature] = Buffer.from(sig).toString('hex');
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 20_000);
    let res: Response;
    try {
      res = await this.f(this.base + path, {
        method,
        headers,
        ...(body !== undefined ? { body: payload } : {}),
        signal: ctrl.signal,
      });
    } catch (e) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      throw new RelayerError(
        aborted ? 'timeout' : 'unavailable',
        aborted ? 'relayer timeout' : `relayer unreachable: ${(e as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json: Json = {};
    try {
      json = text ? (JSON.parse(text) as Json) : {};
    } catch {
      if (res.ok) throw new RelayerError('unknown', 'relayer returned non-JSON', res.status);
    }
    if (!res.ok) throw this.toError(res, json);
    return json;
  }

  private toError(res: Response, json: Json): RelayerError {
    const msg = typeof json.error === 'string' ? json.error : `relayer responded ${res.status}`;
    const ra = Number(res.headers.get('retry-after'));
    const retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined;
    if (res.status === 429) return new RelayerError('rate_limited', msg, 429, retryAfterMs);
    if (res.status === 401 || res.status === 403) return new RelayerError('auth', msg, res.status);
    if (res.status === 404) return new RelayerError('not_found', msg, 404);
    if (res.status === 503 && /paused/i.test(msg)) return new RelayerError('paused', msg, 503, retryAfterMs);
    if (res.status === 502 || res.status === 503 || res.status === 504)
      return new RelayerError('unavailable', msg, res.status, retryAfterMs);
    if (res.status >= 500) return new RelayerError('unknown', msg, res.status, retryAfterMs);
    return new RelayerError('client', msg, res.status);
  }

  async checkCompatibility(): Promise<RelayerVersion> {
    const j = await this.call('GET', this.paths.version, undefined, false);
    const version = String(j.version ?? '');
    const prefixes = this.o.supportedVersionPrefixes ?? [];
    if (prefixes.length && !prefixes.some((p) => version.startsWith(p))) {
      throw new RelayerError('client', `unsupported relayer version ${version}`);
    }
    return { version, ...(typeof j.package_id === 'string' ? { packageId: j.package_id } : {}) };
  }

  async health(): Promise<RelayerHealth> {
    try {
      const j = await this.call('GET', this.paths.health, undefined, false);
      const ws = String(j.writes ?? j.write_state ?? 'ok');
      const writeState: WriteState = ws === 'paused' || ws === 'degraded' ? ws : 'ok';
      return {
        reachable: true,
        writeState,
        ...(typeof j.version === 'string' ? { version: j.version } : {}),
      };
    } catch (e) {
      if (e instanceof RelayerError && e.kind !== 'client' && e.kind !== 'auth')
        return { reachable: false, writeState: 'paused' };
      throw e;
    }
  }

  async remember(namespace: string, text: string): Promise<{ jobId: string }> {
    const j = await this.call('POST', this.paths.remember, { namespace, text });
    return { jobId: this.jobId(j.job_id) };
  }

  async rememberBulk(namespace: string, texts: string[]): Promise<{ jobIds: string[] }> {
    if (texts.length === 0) return { jobIds: [] };
    if (texts.length > MAX_BULK) throw new RelayerError('client', `bulk limited to ${MAX_BULK} items`);
    const j = await this.call('POST', this.paths.rememberBulk, {
      namespace,
      items: texts.map((text) => ({ text })),
    });
    const ids = Array.isArray(j.job_ids) ? j.job_ids.map((x) => this.jobId(x)) : [];
    if (ids.length !== texts.length)
      throw new RelayerError('unknown', 'bulk response did not return one job per item');
    return { jobIds: ids };
  }

  private jobId(v: unknown): string {
    if (typeof v !== 'string' || !v) throw new RelayerError('unknown', 'relayer response missing job id');
    return v;
  }

  async getJob(jobId: string): Promise<JobStatus> {
    const j = await this.call('GET', this.paths.job(jobId));
    const state = String(j.state ?? '');
    if (state === 'done' || state === 'completed') {
      if (typeof j.blob_id !== 'string') throw new RelayerError('unknown', 'done job without blob id');
      return { state: 'done', blobId: j.blob_id };
    }
    if (state === 'failed')
      return { state: 'failed', error: String(j.error ?? 'job failed'), retryable: j.retryable !== false };
    return { state: state === 'running' ? 'running' : 'pending' };
  }

  private mapResults(j: Json): { results: RecalledMemory[] } {
    const arr = Array.isArray(j.results) ? (j.results as Json[]) : [];
    return {
      results: arr.map((r) => ({
        blobId: String(r.blob_id ?? ''),
        text: String(r.text ?? ''),
        ...(typeof r.score === 'number' ? { score: r.score } : {}),
        ...(typeof r.created_at === 'number' ? { createdAt: r.created_at } : {}),
        ...(typeof r.agent_id === 'string' ? { agentId: r.agent_id } : {}),
      })),
    };
  }

  async recall(req: RecallRequest): Promise<{ results: RecalledMemory[] }> {
    const limit = Math.min(100, Math.max(1, req.limit ?? 10));
    const j = await this.call('POST', this.paths.recall, {
      namespace: req.namespace,
      query: req.query,
      limit,
      ...(req.sort ? { sort: req.sort } : {}),
      ...(req.weights ? { weights: req.weights } : {}),
      ...(req.deadlineMs ? { deadline_ms: req.deadlineMs } : {}),
    });
    return this.mapResults(j);
  }

  async analyzeUnused(namespace: string): Promise<{ results: RecalledMemory[] }> {
    return this.mapResults(await this.call('POST', this.paths.analyze, { namespace, mode: 'unused' }));
  }

  async restore(namespace: string, limit = 100): Promise<{ results: RecalledMemory[] }> {
    return this.mapResults(await this.call('POST', this.paths.restore, { namespace, limit }));
  }

  async list(opts: { namespace?: string; cursor?: string; limit?: number }): Promise<MemoryListPage> {
    const q = new URLSearchParams();
    if (opts.namespace) q.set('namespace', opts.namespace);
    if (opts.cursor) q.set('cursor', opts.cursor);
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    const j = await this.call('GET', this.paths.list + (qs ? `?${qs}` : ''));
    const items = (Array.isArray(j.items) ? (j.items as Json[]) : []).map((r) => ({
      blobId: String(r.blob_id ?? ''),
      namespace: String(r.namespace ?? ''),
      sizeBytes: Number(r.size ?? 0),
      status: String(r.status ?? 'unknown'),
      ...(typeof r.agent_id === 'string' ? { agentId: r.agent_id } : {}),
      ...(typeof r.end_epoch === 'number' ? { endEpoch: r.end_epoch } : {}),
      ...(typeof r.expires_at === 'number' ? { expiresAt: r.expires_at } : {}),
    }));
    return {
      items,
      ...(typeof j.next_cursor === 'string' ? { nextCursor: j.next_cursor } : {}),
      hardDeleted: Array.isArray(j.hard_deleted) ? j.hard_deleted.map(String) : [],
    };
  }

  async forget(namespace: string): Promise<void> {
    await this.call('POST', this.paths.forget, { namespace });
  }
}
