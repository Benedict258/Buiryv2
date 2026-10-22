import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { relevance } from '@buiry/core';
import { canonicalRequest, verifyEd25519 } from './signer.js';
import { EPOCH_MS, MAX_BULK, type WriteState } from './adapter.js';

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
  /** Number of 429 responses issued (tests assert the drain never trips the limiter). */
  rateLimitedCount = 0;
  private failures: { n: number; status: number; error: string; retryAfter?: number }[] = [];
  private failJobs = 0;
  private hits: { at: number; weight: number; key: string }[] = [];
  private seq = 0;
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
    const unsigned = path === '/health' || path === '/version';

    if (this.o.verifyAuth && !unsigned) {
      const pk = String(req.headers['x-delegate-key'] ?? '');
      const ts = String(req.headers['x-timestamp'] ?? '');
      const sig = String(req.headers['x-signature'] ?? '');
      let ok = false;
      try {
        ok =
          !!pk &&
          !!req.headers['x-account-id'] &&
          verifyEd25519(
            pk,
            new TextEncoder().encode(canonicalRequest(ts, method, req.url ?? path, raw)),
            Buffer.from(sig, 'hex'),
          );
      } catch {
        ok = false;
      }
      if (!ok) return this.send(res, 401, { error: 'bad signature' });
    }
    const key = String(req.headers['x-delegate-key'] ?? 'anon');
    let json: Record<string, unknown> = {};
    try {
      json = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      return this.send(res, 400, { error: 'invalid json' });
    }

    if (method === 'GET' && path === '/health') {
      return this.send(res, 200, { status: 'ok', writes: this.writeState, version: this.o.version });
    }
    if (method === 'GET' && path === '/version') {
      return this.send(res, 200, { version: this.o.version, package_id: '0xmockpackage' });
    }

    const isWrite = method === 'POST' && (path === '/remember' || path === '/remember/bulk');
    if (isWrite) {
      if (this.writeState === 'paused')
        return this.send(res, 503, { error: 'writes paused' }, { 'retry-after': '5' });
      const f = this.takeFailure();
      if (f)
        return this.send(
          res,
          f.status,
          { error: f.error },
          f.retryAfter !== undefined ? { 'retry-after': String(f.retryAfter) } : {},
        );
    }

    if (method === 'POST' && path === '/remember') {
      if (this.limited(key, 5)) return this.rate(res);
      const ns = String(json.namespace ?? '');
      const text = String(json.text ?? '');
      if (!ns || !text) return this.send(res, 400, { error: 'namespace and text required' });
      return this.send(res, 202, { job_id: this.newJob(ns, text, key) });
    }
    if (method === 'POST' && path === '/remember/bulk') {
      const items = Array.isArray(json.items) ? (json.items as { text?: string }[]) : [];
      if (items.length === 0 || items.length > MAX_BULK)
        return this.send(res, 400, { error: `1..${MAX_BULK} items` });
      if (this.limited(key, items.length * this.o.bulkWeightPerItem)) return this.rate(res);
      const ns = String(json.namespace ?? '');
      return this.send(res, 202, { job_ids: items.map((i) => this.newJob(ns, String(i.text ?? ''), key)) });
    }
    if (method === 'GET' && path.startsWith('/jobs/')) {
      const job = this.jobs.get(decodeURIComponent(path.slice(6)));
      if (!job) return this.send(res, 404, { error: 'no such job' });
      job.polls += 1;
      if (job.failure)
        return this.send(res, 200, {
          state: 'failed',
          error: job.failure.error,
          retryable: job.failure.retryable,
        });
      if (job.polls < this.o.jobPolls)
        return this.send(res, 200, { state: job.polls === 0 ? 'pending' : 'running' });
      if (!job.blobId) this.materialize(job, this.o.now());
      if (this.o.now() < (job.doneAt ?? 0)) return this.send(res, 200, { state: 'running' });
      return this.send(res, 200, { state: 'done', blob_id: job.blobId });
    }
    if (method === 'POST' && (path === '/recall' || path === '/restore' || path === '/analyze')) {
      if (this.limited(key, 1)) return this.rate(res);
      const ns = String(json.namespace ?? '');
      const limit = Math.min(100, Math.max(1, Number(json.limit ?? 10)));
      let pool = this.blobs.filter((b) => b.namespace === ns && this.visible(b));
      if (path === '/recall') {
        const q = String(json.query ?? '');
        const scored = pool.map((b) => ({ b, s: relevance(q, b.text) }));
        scored.sort((a, c) =>
          json.sort === 'recent' ? c.b.createdAt - a.b.createdAt : c.s - a.s || c.b.createdAt - a.b.createdAt,
        );
        return this.send(res, 200, {
          results: scored.slice(0, limit).map((x) => ({
            blob_id: x.b.blobId,
            text: x.b.text,
            score: x.s,
            created_at: x.b.createdAt,
            agent_id: x.b.agentId,
          })),
        });
      }
      pool = [...pool].sort((a, c) => c.createdAt - a.createdAt);
      return this.send(res, 200, {
        results: pool
          .slice(0, limit)
          .map((b) => ({ blob_id: b.blobId, text: b.text, created_at: b.createdAt, agent_id: b.agentId })),
      });
    }
    if (method === 'GET' && path === '/memories') {
      const ns = url.searchParams.get('namespace');
      const limit = Math.min(100, Number(url.searchParams.get('limit') ?? 50));
      const start = Number(url.searchParams.get('cursor') ?? 0);
      const all = this.blobs.filter((b) => !ns || b.namespace === ns);
      const page = all.slice(start, start + limit);
      const now = this.o.now();
      return this.send(res, 200, {
        items: page.map((b) => ({
          blob_id: b.blobId,
          namespace: b.namespace,
          size: Buffer.byteLength(b.text),
          agent_id: b.agentId,
          status: this.hardDeleted.includes(b.blobId) ? 'deleted' : now >= b.expiresAt ? 'expired' : 'active',
          end_epoch: b.endEpoch,
          expires_at: b.expiresAt,
        })),
        ...(start + limit < all.length ? { next_cursor: String(start + limit) } : {}),
        hard_deleted: this.hardDeleted,
      });
    }
    if (method === 'POST' && path === '/forget') {
      return this.send(res, 200, { ok: true });
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

  private newJob(namespace: string, text: string, agentId: string): string {
    this.writeItems += 1;
    const id = `job_${++this.seq}`;
    const job: Job = { id, namespace, text, agentId, polls: 0 };
    if (this.failJobs > 0) {
      this.failJobs -= 1;
      job.failure = { error: 'storage node error', retryable: true };
    }
    this.jobs.set(id, job);
    if (this.o.autoCompleteMs >= 0 && !job.failure)
      this.materialize(job, this.o.now() + this.o.autoCompleteMs);
    return id;
  }
}
