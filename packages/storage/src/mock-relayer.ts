import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { relevance } from '@buiry/core';
import { canonicalRequest, verifyEd25519 } from './signer.js';
import { EPOCH_MS, MAX_BULK, type WriteState } from './adapter.js';

const MOCK_OWNER = '0x' + 'a'.repeat(64);

export interface MockRelayerOptions {
  now?: () => number;
  /** Polls before a job reports done (>=1). */
  jobPolls?: number;
  /** Milliseconds after completion before recall can see a memory. */
  recallLagMs?: number;
  defaultEpochs?: number;
  /** Enforce documented-style limits (60 weighted/min, 500/hr per account; 30 req/min per key). */
  rateLimits?: boolean;
  bulkWeightPerItem?: number;
  verifyAuth?: boolean;
  /**
   * Live behaviour (A23): recall decrypts only with a client-built Seal session (`x-seal-session`); without one
   * every candidate is dropped (HTTP 200, `degraded: true`). Off by default until the adapter sends a session.
   */
  requireSealSession?: boolean;
  version?: string;
  /** When set, the blob is stored when the write is accepted (done after this delay) instead of on first poll. */
  autoCompleteMs?: number;
}

export interface StoredBlob {
  blobId: string;
  namespace: string;
  text: string;
  agentId: string;
  createdAt: number;
  doneAt: number;
  endEpoch: number;
  expiresAt: number;
}

interface Job {
  id: string;
  namespace: string;
  text: string;
  agentId: string;
  polls: number;
  blobId?: string;
  doneAt?: number;
  failure?: { error: string; retryable: boolean };
}

/** In-process HTTP server that simulates the relayer behaviours Buiry must tolerate. */
export class MockRelayer {
  readonly blobs: StoredBlob[] = [];
  readonly jobs = new Map<string, Job>();
  writeState: WriteState = 'ok';
  /** Counts accepted write requests (remember + bulk items); the mock does not deduplicate. */
  writeItems = 0;
  hardDeleted: string[] = [];
  /** Live behaviour: answer recall with HTTP 200, no results, `degraded: true` and every candidate dropped. */
  recallDegraded = false;
  /** Number of 429 responses issued (tests assert the drain never trips the limiter). */
  rateLimitedCount = 0;
  private failures: { n: number; status: number; error: string; retryAfter?: number }[] = [];
  private failJobs = 0;
  private hits: { at: number; weight: number; key: string }[] = [];
  private seq = 0;
  private readonly nonces = new Set<string>();
  private readonly byKey = new Map<string, string>();
  private server!: Server;
  url = '';
  readonly o: Required<MockRelayerOptions>;

  private constructor(o: MockRelayerOptions) {
    this.o = {
      now: o.now ?? Date.now,
      jobPolls: o.jobPolls ?? 1,
      recallLagMs: o.recallLagMs ?? 0,
      defaultEpochs: o.defaultEpochs ?? 3,
      rateLimits: o.rateLimits ?? false,
      bulkWeightPerItem: o.bulkWeightPerItem ?? 5,
      verifyAuth: o.verifyAuth ?? false,
      requireSealSession: o.requireSealSession ?? false,
      version: o.version ?? '1.0.0',
      autoCompleteMs: o.autoCompleteMs ?? -1,
    };
  }

  static async start(o: MockRelayerOptions = {}): Promise<MockRelayer> {
    const m = new MockRelayer(o);
    m.server = createServer((req, res) => void m.handle(req, res));
    await new Promise<void>((r) => m.server.listen(0, '127.0.0.1', r));
    m.url = `http://127.0.0.1:${(m.server.address() as AddressInfo).port}`;
    return m;
  }

  async close(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Make the next n write requests fail with the given status. */
  failNextWrites(n: number, status = 503, error = 'unavailable', retryAfter?: number): void {
    this.failures.push({ n, status, error, ...(retryAfter !== undefined ? { retryAfter } : {}) });
  }

  clearFailures(): void {
    this.failures = [];
  }

  /** Make the next n jobs end in a failed state. */
  failNextJobs(n: number): void {
    this.failJobs += n;
  }

  currentEpoch(at = this.o.now()): number {
    return Math.floor(at / EPOCH_MS);
  }

  private takeFailure(): { status: number; error: string; retryAfter?: number } | null {
    const f = this.failures[0];
    if (!f) return null;
    f.n -= 1;
    if (f.n <= 0) this.failures.shift();
    return f;
  }

  private limited(key: string, weight: number): number | null {
    if (!this.o.rateLimits) return null;
    const now = this.o.now();
    this.hits = this.hits.filter((h) => now - h.at < 3_600_000);
    const minute = this.hits.filter((h) => now - h.at < 60_000);
    const sumMin = minute.reduce((a, h) => a + h.weight, 0);
    const sumHr = this.hits.reduce((a, h) => a + h.weight, 0);
    const keyReqs = minute.filter((h) => h.key === key).length;
    if (sumMin + weight > 60 || sumHr + weight > 500 || keyReqs + 1 > 30) return 1;
    this.hits.push({ at: now, weight, key });
    return null;
  }

  private send(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  }

  private rate(res: ServerResponse): void {
    this.rateLimitedCount += 1;
    this.send(res, 429, { error: 'rate limited' }, { 'retry-after': '10' });
  }

  private async body(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }

  private visible(b: StoredBlob): boolean {
    const now = this.o.now();
    return now >= b.doneAt + this.o.recallLagMs && now < b.expiresAt && !this.hardDeleted.includes(b.blobId);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const raw = await this.body(req);
    const method = req.method ?? 'GET';
    const unsigned = path === '/health' || path === '/version' || path === '/config';

    if (this.o.verifyAuth && !unsigned) {
      const h = (n: string): string => String(req.headers[n] ?? '');
      const pk = h('x-public-key');
      const ts = h('x-timestamp');
      const nonce = h('x-nonce');
      const account = h('x-account-id');
      const sig = h('x-signature');
      // Documented rules: signed {ts}.{METHOD}.{path+query}.{sha256(body)}.{nonce}.{account}, 5-minute
      // timestamp window, nonce replay protection. A raw delegate key header is never accepted.
      let ok = false;
      try {
        const fresh = Math.abs(this.o.now() / 1000 - Number(ts)) <= 300;
        ok =
          !!pk &&
          !!nonce &&
          fresh &&
          !this.nonces.has(nonce) &&
          !req.headers['x-delegate-key'] &&
          verifyEd25519(
            pk,
            new TextEncoder().encode(canonicalRequest(ts, method, req.url ?? path, raw, nonce, account)),
            Buffer.from(sig, 'hex'),
          );
      } catch {
        ok = false;
      }
      if (!ok) return this.send(res, 401, { error: 'bad signature' });
      this.nonces.add(nonce);
    }
    const key = String(req.headers['x-public-key'] ?? 'anon');
    let json: Record<string, unknown> = {};
    try {
      json = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      return this.send(res, 400, { error: 'invalid json' });
    }

    if (method === 'GET' && path === '/health') {
      return this.send(res, 200, {
        status: 'ok',
        version: this.o.version,
        relayerVersion: this.o.version,
        apiVersion: this.o.version,
        write_ready: true,
        writes: this.writeState,
      });
    }
    if (method === 'GET' && path === '/version') {
      return this.send(res, 200, {
        relayerVersion: this.o.version,
        apiVersion: this.o.version,
        minSupportedSdk: { typescript: '0.1.8', python: '0.1.0', mcp: '0.1.0' },
        deprecations: [],
      });
    }

    const isWrite = method === 'POST' && (path === '/api/remember' || path === '/api/remember/bulk');
    if (isWrite) {
      if (this.writeState === 'paused') return this.send(res, 503, { error: 'writes are paused' });
      const f = this.takeFailure();
      if (f)
        return this.send(
          res,
          f.status,
          { error: f.error },
          f.retryAfter !== undefined ? { 'retry-after': String(f.retryAfter) } : {},
        );
    }

    if (method === 'POST' && path === '/api/remember') {
      if (this.limited(key, 5)) return this.rate(res);
      const ns = String(json.namespace ?? 'default');
      const text = String(json.text ?? '');
      if (!text) return this.send(res, 400, { error: 'text required' });
      const k = typeof json.idempotency_key === 'string' ? json.idempotency_key : undefined;
      const existing = k ? this.byKey.get(k) : undefined;
      if (existing) {
        const prior = this.jobs.get(existing)!;
        if (prior.text !== text)
          return this.send(res, 409, { error: 'idempotency key reused with different text' });
        return this.send(res, 202, { job_id: existing, status: 'running' });
      }
      return this.send(res, 202, { job_id: this.newJob(ns, text, key, k), status: 'running' });
    }
    if (method === 'POST' && path === '/api/remember/bulk') {
      const items = Array.isArray(json.items) ? (json.items as { text?: string; namespace?: string }[]) : [];
      if (items.length === 0 || items.length > MAX_BULK)
        return this.send(res, 400, { error: `1..${MAX_BULK} items` });
      if (this.limited(key, items.length * this.o.bulkWeightPerItem)) return this.rate(res);
      const bulkKey = typeof json.idempotency_key === 'string' ? json.idempotency_key : undefined;
      const job_ids = items.map((i, n) => {
        const k = bulkKey ? `bulk:${bulkKey}:${n}` : undefined;
        const existing = k ? this.byKey.get(k) : undefined;
        return existing ?? this.newJob(String(i.namespace ?? 'default'), String(i.text ?? ''), key, k);
      });
      return this.send(res, 202, { job_ids, total: job_ids.length, status: 'running' });
    }
    if (method === 'GET' && path.startsWith('/api/remember/')) {
      const job = this.jobs.get(decodeURIComponent(path.slice('/api/remember/'.length)));
      if (!job) return this.send(res, 404, { error: 'no such job' });
      const base = { job_id: job.id, owner: MOCK_OWNER, namespace: job.namespace };
      job.polls += 1;
      if (job.failure) return this.send(res, 200, { ...base, status: 'failed', error: job.failure.error });
      if (job.polls < this.o.jobPolls)
        return this.send(res, 200, { ...base, status: job.polls === 0 ? 'pending' : 'running' });
      if (!job.blobId) this.materialize(job, this.o.now());
      if (this.o.now() < (job.doneAt ?? 0)) return this.send(res, 200, { ...base, status: 'uploaded' });
      return this.send(res, 200, { ...base, status: 'done', blob_id: job.blobId });
    }
    if (method === 'POST' && path === '/api/recall') {
      if (this.limited(key, 1)) return this.rate(res);
      const ns = String(json.namespace ?? 'default');
      const limit = Math.min(100, Math.max(1, Number(json.limit ?? 10)));
      const pool = this.blobs.filter((b) => b.namespace === ns && this.visible(b));
      const q = String(json.query ?? '');
      if (this.recallDegraded || (this.o.requireSealSession && !req.headers['x-seal-session']))
        return this.send(res, 200, { results: [], total: 0, dropped_count: pool.length, degraded: true });
      const scored = pool.map((b) => ({ b, s: relevance(q, b.text) }));
      scored.sort((a, c) =>
        json.sort === 'recent' ? c.b.createdAt - a.b.createdAt : c.s - a.s || c.b.createdAt - a.b.createdAt,
      );
      // Documented result fields: blob_id, text, distance (cosine, lower is closer); no score unless weighted.
      return this.send(res, 200, {
        results: scored
          .slice(0, limit)
          .map((x) => ({ blob_id: x.b.blobId, text: x.b.text, distance: 1 - x.s })),
        total: Math.min(limit, scored.length),
      });
    }
    if (method === 'POST' && path === '/api/restore') {
      if (this.limited(key, 1)) return this.rate(res);
      const ns = String(json.namespace ?? 'default');
      const limit = Math.min(100, Math.max(1, Number(json.limit ?? 10)));
      const total = Math.min(limit, this.blobs.filter((b) => b.namespace === ns && this.visible(b)).length);
      // Counts only: restore re-indexes server-side and never returns memory text.
      return this.send(res, 200, {
        restored: 0,
        skipped: total,
        failed: 0,
        total,
        namespace: ns,
        owner: MOCK_OWNER,
        truncated: false,
      });
    }
    if (method === 'POST' && path === '/api/stats') {
      const ns = String(json.namespace ?? 'default');
      const mine = this.blobs.filter((b) => b.namespace === ns);
      return this.send(res, 200, {
        memory_count: mine.length,
        storage_bytes: mine.reduce((a, b) => a + Buffer.byteLength(b.text), 0),
        namespace: ns,
        owner: MOCK_OWNER,
      });
    }
    if (method === 'GET' && path === `/v1/owners/${MOCK_OWNER}/memories`) {
      const limit = Math.min(100, Number(url.searchParams.get('limit') ?? 50));
      const start = Number(url.searchParams.get('updated_after') ?? 0);
      const page = this.blobs.slice(start, start + limit);
      const now = this.o.now();
      const hasMore = start + limit < this.blobs.length;
      return this.send(res, 200, {
        memories: page.map((b, i) => ({
          memory_id: `mem_${start + i}`,
          namespace_id: b.namespace,
          blob_id: b.blobId,
          created_at: b.createdAt,
          updated_at: b.createdAt,
          size: Buffer.byteLength(b.text),
          agent_id: b.agentId,
          status: this.hardDeleted.includes(b.blobId) ? 'deleted' : now >= b.expiresAt ? 'expired' : 'active',
          end_epoch: b.endEpoch,
          expires_at: b.expiresAt,
        })),
        has_more: hasMore,
        ...(hasMore ? { next_cursor: String(start + limit) } : {}),
        snapshot_version: 1,
        deleted: this.hardDeleted.map((id) => ({
          memory_id: id,
          namespace_id: this.blobs.find((b) => b.blobId === id)?.namespace ?? '',
          deleted_at: now,
        })),
        must_resync: false,
      });
    }
    if (method === 'POST' && path === '/api/forget') {
      return this.send(res, 200, {
        deleted: 0,
        namespace: String(json.namespace ?? 'default'),
        owner: MOCK_OWNER,
      });
    }
    return this.send(res, 404, { error: 'not found' });
  }

  private materialize(job: Job, doneAt: number): void {
    const now = this.o.now();
    const blobId = `blob_${createHash('sha256').update(job.id).digest('hex').slice(0, 16)}`;
    job.blobId = blobId;
    job.doneAt = doneAt;
    const epochs = this.o.defaultEpochs;
    this.blobs.push({
      blobId,
      namespace: job.namespace,
      text: job.text,
      agentId: job.agentId,
      createdAt: now,
      doneAt,
      endEpoch: this.currentEpoch(now) + epochs,
      expiresAt: (this.currentEpoch(now) + epochs) * EPOCH_MS,
    });
  }

  private newJob(namespace: string, text: string, agentId: string, idempotencyKey?: string): string {
    this.writeItems += 1;
    const id = `job_${++this.seq}`;
    const job: Job = { id, namespace, text, agentId, polls: 0 };
    if (this.failJobs > 0) {
      this.failJobs -= 1;
      job.failure = { error: 'storage node error', retryable: true };
    }
    this.jobs.set(id, job);
    if (idempotencyKey) this.byKey.set(idempotencyKey, id);
    if (this.o.autoCompleteMs >= 0 && !job.failure)
      this.materialize(job, this.o.now() + this.o.autoCompleteMs);
    return id;
  }
}
