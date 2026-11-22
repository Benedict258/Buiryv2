import { randomUUID } from 'node:crypto';
import {
  MAX_BULK,
  RelayerError,
  type JobStatus,
  type MemoryListPage,
  type RecallRequest,
  type RecallResponse,
  type RelayerHealth,
  type RelayerVersion,
  type RestoreResult,
  type WalrusMemoryAdapter,
  type WriteOptions,
  type WriteState,
} from './adapter.js';
import { canonicalRequest, type Signer } from './signer.js';
import type { SealSessionSource } from './seal-session.js';

/**
 * Endpoint paths from the relayer api-reference and the SDK source (A14, read 2026-10-28).
 * Overridable per relayer without touching callers.
 */
export interface RelayerPaths {
  remember: string;
  rememberBulk: string;
  job: (id: string) => string;
  recall: string;
  restore: string;
  stats: string;
  forget: string;
  health: string;
  version: string;
  /** Unsigned relayer configuration (Seal `packageId`, `network`). */
  config: string;
  /** Memory Read API listing for an owner address. */
  list: (owner: string) => string;
}

export const DEFAULT_PATHS: RelayerPaths = {
  remember: '/api/remember',
  rememberBulk: '/api/remember/bulk',
  job: (id) => `/api/remember/${encodeURIComponent(id)}`,
  recall: '/api/recall',
  restore: '/api/restore',
  stats: '/api/stats',
  forget: '/api/forget',
  health: '/health',
  version: '/version',
  config: '/config',
  list: (owner) => `/v1/owners/${encodeURIComponent(owner)}/memories`,
};

/**
 * Signed-request header names (A13). `x-delegate-key` is deliberately absent: the relayer defines it as a
 * deprecated header carrying a delegate PRIVATE key, and this client must never send one.
 */
export interface AuthHeaders {
  account: string;
  publicKey: string;
  timestamp: string;
  signature: string;
  nonce: string;
}
export const DEFAULT_AUTH_HEADERS: AuthHeaders = {
  account: 'x-account-id',
  publicKey: 'x-public-key',
  timestamp: 'x-timestamp',
  signature: 'x-signature',
  nonce: 'x-nonce',
};

export interface HttpAdapterOptions {
  baseUrl: string;
  accountId: string;
  signer: Signer;
  fetch?: typeof fetch;
  now?: () => number;
  nonce?: () => string;
  paths?: RelayerPaths;
  authHeaders?: AuthHeaders;
  timeoutMs?: number;
  /** Relayer API versions this build supports (prefixes, e.g. "1."). Empty = accept any. */
  supportedVersionPrefixes?: string[];
  /**
   * Source of the `x-seal-session` header for recall (A23). Without it the relayer drops every recall candidate.
   * Can also be attached later with `useSealSession`.
   */
  sealSession?: SealSessionSource & { scrub?(text: string): string; invalidate?(): void };
  /** Extra attempts for read calls (recall) after a timeout or an unreachable relayer. Default 1. */
  readRetries?: number;
  /** Base delay before a read retry, doubled per attempt. Default 500 ms. */
  readBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

type Json = Record<string, unknown>;

/** Accepts epoch milliseconds, epoch seconds or an RFC 3339 string. */
function toMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e11 ? v : v * 1000;
  if (typeof v === 'string' && v) {
    const n = Date.parse(v);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

export class HttpWalrusAdapter implements WalrusMemoryAdapter {
  private readonly f: typeof fetch;
  private readonly now: () => number;
  private readonly newNonce: () => string;
  private readonly paths: RelayerPaths;
  private readonly hdr: AuthHeaders;
  private readonly base: string;
  private owner?: string;
  private seal?: HttpAdapterOptions['sealSession'];

  constructor(private readonly o: HttpAdapterOptions) {
    this.f = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
    this.newNonce = o.nonce ?? randomUUID;
    this.paths = o.paths ?? DEFAULT_PATHS;
    this.hdr = o.authHeaders ?? DEFAULT_AUTH_HEADERS;
    this.base = o.baseUrl.replace(/\/+$/, '');
    this.seal = o.sealSession;
  }

  /** Attach the Seal session source after construction (it may need this adapter's `relayerConfig`). */
  useSealSession(source: NonNullable<HttpAdapterOptions['sealSession']>): void {
    this.seal = source;
  }

  /** Unsigned `GET /config`: the Seal `packageId` and `network` the relayer decrypts for. */
  async relayerConfig(): Promise<{ packageId: string; network: string }> {
    const { json: j } = await this.withReadRetry(() => this.call('GET', this.paths.config, undefined, false));
    if (typeof j.packageId !== 'string' || !j.packageId || typeof j.network !== 'string' || !j.network)
      throw new RelayerError('unknown', 'relayer /config is missing packageId or network');
    return { packageId: j.packageId, network: j.network };
  }

  /** `pathAndQuery` is what gets signed and requested: the relayer verifies against path plus query. */
  private async call(
    method: 'GET' | 'POST',
    pathAndQuery: string,
    body?: Json,
    signed = true,
    okStatuses: number[] = [],
    extraHeaders: Record<string, string> = {},
  ): Promise<{ json: Json; status: number }> {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = { accept: 'application/json', ...extraHeaders };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (signed) {
      const ts = String(Math.floor(this.now() / 1000));
      const nonce = this.newNonce();
      const sig = await this.o.signer.sign(
        new TextEncoder().encode(
          canonicalRequest(ts, method, pathAndQuery, payload, nonce, this.o.accountId),
        ),
      );
      headers[this.hdr.account] = this.o.accountId;
      headers[this.hdr.publicKey] = this.o.signer.publicKeyHex;
      headers[this.hdr.timestamp] = ts;
      headers[this.hdr.nonce] = nonce;
      headers[this.hdr.signature] = Buffer.from(sig).toString('hex');
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 20_000);
    let res: Response;
    try {
      res = await this.f(this.base + pathAndQuery, {
        method,
        headers,
        ...(body !== undefined ? { body: payload } : {}),
        signal: ctrl.signal,
      });
    } catch (e) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      const err = new RelayerError(
        aborted ? 'timeout' : 'unavailable',
        aborted ? 'relayer timeout' : `relayer unreachable${causeCode(e)}`, // sweep A12: no exception text
      );
      const code = causeCode(e).replace(/^ \(|\)$/g, '');
      if (code) err.netCode = code;
      throw err;
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
    if (!res.ok && !okStatuses.includes(res.status)) throw this.toError(res, json);
    return { json, status: res.status };
  }

  private toError(res: Response, json: Json): RelayerError {
    const msg =
      typeof json.error === 'string'
        ? json.error
        : (json.message as string) || `relayer responded ${res.status}`;
    // Retry delay: the Retry-After header, else `retry_after_seconds` in the body (SDK source).
    const ra = Number(res.headers.get('retry-after') ?? json.retry_after_seconds);
    const retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined;
    if (res.status === 429) return new RelayerError('rate_limited', msg, 429, retryAfterMs);
    if (res.status === 401 || res.status === 403) return new RelayerError('auth', msg, res.status);
    if (res.status === 404) return new RelayerError('not_found', msg, 404);
    if (res.status === 409) return new RelayerError('client', msg, 409);
    if (res.status === 503 && /paused/i.test(msg)) return new RelayerError('paused', msg, 503, retryAfterMs);
    if (res.status === 504 && json.code === 'RECALL_TIMEOUT')
      return new RelayerError('timeout', msg, 504, retryAfterMs);
    if (res.status === 502 || res.status === 503 || res.status === 504)
      return new RelayerError('unavailable', msg, res.status, retryAfterMs);
    if (res.status >= 500) return new RelayerError('unknown', msg, res.status, retryAfterMs);
    return new RelayerError('client', msg, res.status);
  }

  async checkCompatibility(): Promise<RelayerVersion> {
    const { json: j } = await this.call('GET', this.paths.version, undefined, false);
    const version = String(j.relayerVersion ?? j.version ?? '');
    const apiVersion = String(j.apiVersion ?? version);
    const prefixes = this.o.supportedVersionPrefixes ?? [];
    if (prefixes.length && !prefixes.some((p) => apiVersion.startsWith(p))) {
      throw new RelayerError('client', `unsupported relayer api version ${apiVersion}`);
    }
    const pkg = j.packageId ?? j.package_id;
    return { version, ...(typeof pkg === 'string' ? { packageId: pkg } : {}) };
  }

  async health(): Promise<RelayerHealth> {
    try {
      const { json: j } = await this.call('GET', this.paths.health, undefined, false);
      // `writes` is the pause/outage signal; `write_ready` is a separate sidecar/database probe.
      const ws = String(j.writes ?? 'ok');
      const writeState: WriteState = ws === 'paused' || ws === 'degraded' ? ws : 'ok';
      const v = j.relayerVersion ?? j.version;
      return { reachable: true, writeState, ...(typeof v === 'string' ? { version: v } : {}) };
    } catch (e) {
      if (e instanceof RelayerError && e.kind !== 'client' && e.kind !== 'auth')
        return { reachable: false, writeState: 'paused' };
      throw e;
    }
  }

  private keyed(opts?: WriteOptions): Json {
    return opts?.idempotencyKey ? { idempotency_key: opts.idempotencyKey } : {};
  }

  async remember(namespace: string, text: string, opts?: WriteOptions): Promise<{ jobId: string }> {
    const { json: j } = await this.call('POST', this.paths.remember, {
      text,
      namespace,
      ...this.keyed(opts),
    });
    return { jobId: this.jobId(j.job_id) };
  }

  async rememberBulk(namespace: string, texts: string[], opts?: WriteOptions): Promise<{ jobIds: string[] }> {
    if (texts.length === 0) return { jobIds: [] };
    if (texts.length > MAX_BULK) throw new RelayerError('client', `bulk limited to ${MAX_BULK} items`);
    const { json: j } = await this.call('POST', this.paths.rememberBulk, {
      items: texts.map((text) => ({ text, namespace })),
      ...this.keyed(opts),
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
    const { json: j } = await this.call('GET', this.paths.job(jobId));
    const status = String(j.status ?? '');
    if (status === 'done') {
      if (typeof j.blob_id !== 'string' || !j.blob_id)
        throw new RelayerError('unknown', 'done job without blob id');
      return { state: 'done', blobId: j.blob_id };
    }
    if (status === 'failed')
      return { state: 'failed', error: String(j.error ?? 'job failed'), retryable: j.retryable !== false };
    if (status === 'not_found') throw new RelayerError('not_found', 'no such job', 404);
    // `uploaded` means the blob is on Walrus but indexing has not finished: not done yet.
    return { state: status === 'pending' ? 'pending' : 'running' };
  }

  async recall(req: RecallRequest): Promise<RecallResponse> {
    const limit = Math.min(100, Math.max(1, req.limit ?? 10));
    const body = {
      query: req.query,
      namespace: req.namespace,
      limit,
      ...(req.sort ? { sort: req.sort } : {}),
      ...(req.weights && !req.sort ? { scoring_weights: req.weights } : {}),
      ...(req.deadlineMs ? { deadline_ms: req.deadlineMs } : {}),
    };
    const j = await this.withReadRetry(async () => {
      const extra: Record<string, string> = this.seal ? { 'x-seal-session': await this.seal.header() } : {};
      try {
        return (await this.call('POST', this.paths.recall, body, true, [], extra)).json;
      } catch (e) {
        // Scrub first: invalidating forgets the session value the scrubber matches on.
        const clean = this.scrubbed(e);
        if (e instanceof RelayerError && e.kind === 'auth') this.seal?.invalidate?.();
        throw clean;
      }
    });
    const arr = Array.isArray(j.results) ? (j.results as Json[]) : [];
    const dropped = typeof j.dropped_count === 'number' ? j.dropped_count : 0;
    return {
      ...(j.degraded === true ? { degraded: true } : {}),
      ...(dropped > 0 ? { dropped } : {}),
      results: arr.map((r) => {
        const created = toMs(r.created_at);
        return {
          blobId: String(r.blob_id ?? ''),
          text: String(r.text ?? ''),
          ...(typeof r.score === 'number' ? { score: r.score } : {}),
          ...(typeof r.distance === 'number' ? { distance: r.distance } : {}),
          ...(created !== undefined ? { createdAt: created } : {}),
          ...(typeof r.agent_id === 'string' ? { agentId: r.agent_id } : {}),
        };
      }),
    };
  }

  /** Retries a read (recall, stats, listing) once by default after a timeout or an unreachable relayer, with backoff. */
  private async withReadRetry<T>(fn: () => Promise<T>): Promise<T> {
    const retries = this.o.readRetries ?? 1;
    const base = this.o.readBackoffMs ?? 500;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        const transient = e instanceof RelayerError && (e.kind === 'timeout' || e.kind === 'unavailable');
        if (!transient || attempt >= retries) throw e;
        await sleep(e.retryAfterMs ?? base * 2 ** attempt);
      }
    }
  }

  /** Rebuilds an error so the Seal session (or key) can never appear in its message. */
  private scrubbed(e: unknown): unknown {
    if (!(e instanceof RelayerError) || !this.seal?.scrub) return e;
    const msg = this.seal.scrub(e.message);
    return msg === e.message ? e : new RelayerError(e.kind, msg, e.status, e.retryAfterMs);
  }

  async restore(namespace: string, limit = 10): Promise<RestoreResult> {
    const { json: j } = await this.call('POST', this.paths.restore, {
      namespace,
      limit: Math.min(100, Math.max(1, limit)),
    });
    return {
      restored: Number(j.restored ?? 0),
      skipped: Number(j.skipped ?? 0),
      failed: Number(j.failed ?? 0),
      total: Number(j.total ?? 0),
      // Relayers older than WALM-319 omit the field; the SDK defaults it to false.
      truncated: j.truncated === true,
    };
  }

  /** The Memory Read API is keyed by owner address, which the relayer reports from `POST /api/stats`. */
  private async ownerAddress(): Promise<string> {
    if (this.owner) return this.owner;
    const { json: j } = await this.withReadRetry(() =>
      this.call('POST', this.paths.stats, { namespace: 'default' }),
    );
    if (typeof j.owner !== 'string' || !j.owner)
      throw new RelayerError('unknown', 'relayer stats response missing owner');
    this.owner = j.owner;
    return this.owner;
  }

  async list(opts: { namespace?: string; cursor?: string; limit?: number }): Promise<MemoryListPage> {
    const owner = await this.ownerAddress();
    const q = new URLSearchParams();
    if (opts.cursor) q.set('updated_after', opts.cursor);
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    const { json: j } = await this.withReadRetry(() =>
      this.call('GET', this.paths.list(owner) + (qs ? `?${qs}` : '')),
    );
    const inNs = (r: Json): boolean =>
      !opts.namespace || r.namespace_id === opts.namespace || r.namespace === opts.namespace;
    const items = (Array.isArray(j.memories) ? (j.memories as Json[]) : []).filter(inNs).map((r) => {
      const expiresAt = toMs(r.expires_at);
      return {
        blobId: String(r.blob_id ?? ''),
        namespace: String(r.namespace_id ?? r.namespace ?? ''),
        sizeBytes: Number(r.size ?? 0),
        status: String(r.status ?? 'unknown'),
        ...(typeof r.agent_id === 'string' ? { agentId: r.agent_id } : {}),
        ...(typeof r.end_epoch === 'number' ? { endEpoch: r.end_epoch } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      };
    });
    const deleted = (Array.isArray(j.deleted) ? (j.deleted as Json[]) : []).filter(inNs);
    return {
      items,
      ...(j.has_more === true && typeof j.next_cursor === 'string' ? { nextCursor: j.next_cursor } : {}),
      // Deleted entries carry memory_id and namespace_id; a blob_id is used when the relayer provides one.
      hardDeleted: deleted.map((d) => String(d.blob_id ?? d.memory_id ?? '')).filter(Boolean),
    };
  }

  /** Index removal only: Walrus blobs persist and `restore` can re-index them. */
  async forget(namespace: string): Promise<void> {
    await this.call('POST', this.paths.forget, { namespace });
  }
}

/** Appends the low-level network error code (for example UND_ERR_CONNECT_TIMEOUT) when there is one. */
function causeCode(e: unknown): string {
  const code = (e as { cause?: { code?: unknown } })?.cause?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code) ? ` (${code})` : '';
}
