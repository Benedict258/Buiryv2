import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Ed25519Signer,
  HttpWalrusAdapter,
  InMemoryWriteQueue,
  MockRelayer,
  PgWriteQueue,
  WRITE_JOBS_DDL,
  WriteService,
  WriteWorker,
  PointsLimiter,
  deriveBudgets,
  backoffMs,
  type WriteQueue,
} from '../src/index.js';
import { Clock, jobInput, rng } from './helpers.js';

const open: MockRelayer[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function rig(o: { relayer?: object; queue?: WriteQueue; worker?: object } = {}) {
  const clock = new Clock();
  const mock = await MockRelayer.start({ now: clock.now, ...(o.relayer ?? {}) });
  open.push(mock);
  const adapter = new HttpWalrusAdapter({
    baseUrl: mock.url,
    accountId: '0xacct',
    signer: new Ed25519Signer('22'.repeat(32)),
    now: clock.now,
  });
  const queue = o.queue ?? new InMemoryWriteQueue();
  const r = rng(7);
  const stored: string[] = [];
  const dead: string[] = [];
  const mkWorker = (id = 'w1', extra: object = {}) =>
    new WriteWorker({
      queue,
      adapter,
      workerId: id,
      now: clock.now,
      random: r.next,
      onStored: (j, blob) => void stored.push(`${j.id}:${blob}`),
      onDead: (j) => void dead.push(j.id),
      ...(o.worker ?? {}),
      ...extra,
    });
  const svc = new WriteService(queue, clock.now, r.bytes);
  return { clock, mock, adapter, queue, mkWorker, svc, stored, dead };
}

const drain = async (w: WriteWorker, clock: Clock, n = 20, step = 2500) => {
  for (let i = 0; i < n; i++) {
    await w.tick();
    clock.advance(step);
  }
};

describe('write path', () => {
  it('accepts fast (queued), batches into bulk writes and records blob ids', async () => {
    const { svc, mkWorker, clock, queue, mock, stored } = await rig();
    for (let i = 0; i < 5; i++)
      expect(await svc.accept(jobInput(i))).toMatchObject({ ok: true, state: 'queued', duplicate: false });
    const w = mkWorker();
    const first = await w.tick();
    expect(first.submitted).toBe(5);
    expect(mock.writeItems).toBe(5);
    await drain(w, clock, 3);
    expect((await queue.stats(clock.now())).stored).toBe(5);
    expect(stored).toHaveLength(5);
    expect(mock.blobs.map((b) => b.text).sort()).toEqual(
      (await Promise.all([0, 1, 2, 3, 4].map(async (i) => jobInput(i).text))).sort(),
    );
  });

  it('uses single remember for one item and caps bulk at 20', async () => {
    const { svc, mkWorker, clock, mock } = await rig();
    await svc.accept(jobInput(0));
    const w = mkWorker();
    expect((await w.tick()).submitted).toBe(1);
    for (let i = 1; i <= 25; i++) await svc.accept(jobInput(i, { agent: `agent${i}` }));
    clock.advance(1);
    expect((await w.tick()).submitted).toBe(11); // limiter: 60 points/min = 12 writes, 1 used
    expect(mock.writeItems).toBe(12);
  });

  it('suppresses duplicates: replays return the original job and never reach the relayer twice', async () => {
    const { svc, mkWorker, clock, mock } = await rig();
    const a = await svc.accept(jobInput(1));
    const b = await svc.accept(jobInput(1)); // reconnect replay
    expect(b).toMatchObject({ ok: true, duplicate: true });
    expect(a.ok && b.ok && a.jobId === b.jobId).toBe(true);
    const c = await svc.accept({ ...jobInput(1), text: jobInput(1).text + ' edited' });
    expect(c.ok && c.duplicate).toBe(false);
    await drain(mkWorker(), clock, 4);
    expect(mock.writeItems).toBe(2);
  });

  it('retries retryable errors with backoff, honours retry-after, and never retries auth/client errors', async () => {
    // A 1 s backoff floor here, so the relayer's 30 s retry-after is what decides (the default floor is 10 minutes, F1).
    const { svc, mkWorker, clock, mock, queue } = await rig({ worker: { backoffBaseMs: 1000 } });
    await svc.accept(jobInput(1));
    const w = mkWorker();
    mock.failNextWrites(1, 429, 'slow', 30);
    expect((await w.tick()).retried).toBe(1);
    clock.advance(10_000);
    expect((await w.tick()).submitted).toBe(0); // still inside retry-after (30s)
    clock.advance(25_000);
    expect((await w.tick()).submitted).toBe(1);

    await svc.accept(jobInput(2));
    mock.failNextWrites(1, 400, 'bad request');
    clock.advance(1000);
    const r = await w.tick();
    expect(r.dead).toBe(1);
    expect(r.retried).toBe(0);
    const dead = await queue.listDead(10);
    expect(dead[0]!.lastError).toMatch(/client/);
  });

  it('dead-letters after the retry budget and can be requeued', async () => {
    const { svc, mkWorker, clock, mock, queue, dead } = await rig({
      worker: { maxAttempts: 3, backoffBaseMs: 100, backoffCapMs: 200 },
    });
    await svc.accept(jobInput(1));
    mock.failNextWrites(10, 503, 'down');
    const w = mkWorker();
    await drain(w, clock, 8, 1000);
    expect((await queue.stats(clock.now())).dead).toBe(1);
    expect(dead).toHaveLength(1);
    const d = (await queue.listDead(1))[0]!;
    expect(d.attempts).toBe(3);
    expect(d.lastError).toMatch(/retries exhausted/);
    mock.clearFailures();
    await queue.requeue(d.id, clock.now());
    await drain(w, clock, 4);
    expect((await queue.get(d.id))!.state).toBe('stored');
  });

  it('failure events carry the error kind and HTTP status as fields, never the response text (Phase 14d)', async () => {
    const logs: string[] = [];
    const { svc, mkWorker, clock, mock } = await rig({
      worker: {
        maxAttempts: 2,
        backoffBaseMs: 100,
        backoffCapMs: 200,
        log: (l: string) => void logs.push(l),
      },
    });
    await svc.accept(jobInput(1));
    mock.failNextWrites(10, 503, 'down sk-made-up-SECRET-123');
    await drain(mkWorker(), clock, 6, 1000);
    const events = logs.map((l) => JSON.parse(l) as { status?: string; error?: unknown });
    const retry = events.find((e) => e.status === 'retry_scheduled');
    const dead = events.find((e) => e.status === 'dead');
    expect(retry?.error).toEqual({ kind: 'unavailable', status: 503 });
    expect(dead?.error).toEqual({ kind: 'unavailable', status: 503 });
    expect(logs.join('\n')).not.toContain('sk-made-up');
  });

  it('handles failed relayer jobs as retryable', async () => {
    const { svc, mkWorker, clock, mock, queue } = await rig({ worker: { backoffBaseMs: 1000 } });
    await svc.accept(jobInput(1));
    mock.failNextJobs(1);
    await drain(mkWorker(), clock, 12, 3000);
    expect((await queue.stats(clock.now())).stored).toBe(1);
    expect(mock.writeItems).toBe(2); // resubmitted once
  });

  it('pauses draining when the relayer reports paused or degraded (Phase 10 F1), and skips when unreachable', async () => {
    const { svc, mkWorker, clock, mock, queue } = await rig();
    for (let i = 0; i < 6; i++) await svc.accept(jobInput(i, { agent: `a${i}` }));
    const w = mkWorker();
    mock.writeState = 'paused';
    expect(await w.tick()).toMatchObject({ relayer: 'paused', skipped: 'paused', submitted: 0 });
    expect((await queue.stats(clock.now())).queued).toBe(6);
    mock.writeState = 'degraded';
    expect(await w.tick()).toMatchObject({ relayer: 'degraded', skipped: 'degraded', submitted: 0 });
    mock.writeState = 'ok';
    clock.advance(1);
    expect((await w.tick()).submitted).toBe(6);
    await mock.close();
    open.pop();
    expect(await w.tick()).toMatchObject({ relayer: 'unreachable', skipped: 'unreachable' });
    expect(w.lastRelayerState).toBe('unreachable');
  });

  it('backpressure: the drain never trips the relayer rate limiter and the backlog cap rejects new writes', async () => {
    const { svc, mkWorker, clock, mock, queue } = await rig({ relayer: { rateLimits: true } });
    const tight = new WriteService(queue, clock.now, rng(3).bytes, {
      ...deriveBudgets(),
      maxBacklog: 30,
      perAgentPerMinute: 1000,
      perAgentPerHour: 1000,
      perProjectPerMinute: 1000,
      perProjectPerHour: 1000,
    });
    void svc;
    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < 40; i++) {
      const r = await tight.accept(jobInput(i));
      if (r.ok) accepted++;
      else {
        rejected++;
        expect(r).toMatchObject({ code: 'budget_exceeded', scope: 'backlog' });
      }
    }
    expect([accepted, rejected]).toEqual([30, 10]);
    const w = mkWorker();
    for (let i = 0; i < 400; i++) {
      await w.tick();
      clock.advance(1000);
    }
    expect(mock.rateLimitedCount).toBe(0);
    expect((await queue.stats(clock.now())).stored).toBe(30);
  });

  it('per-agent and per-project budgets reject with a retry hint', async () => {
    const { svc } = await rig();
    const results = [];
    for (let i = 0; i < 8; i++) results.push(await svc.accept(jobInput(i, { agent: 'chatty' })));
    expect(results.filter((r) => r.ok)).toHaveLength(6); // derived: floor(12/2) per agent per minute
    const over = results.find((r) => !r.ok)!;
    expect(over).toMatchObject({ ok: false, scope: 'agent', code: 'budget_exceeded' });
    expect((over as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
    expect(await svc.accept(jobInput(100, { agent: 'other' }))).toMatchObject({ ok: true });
  });

  it('points limiter models 60/min, 500/hr and 30 requests/min', () => {
    const l = new PointsLimiter();
    for (let i = 0; i < 12; i++) expect(l.tryTake(5, 0)).toEqual({ ok: true });
    expect(l.tryTake(5, 1000)).toMatchObject({ ok: false });
    expect(l.tryTake(5, 61_000)).toEqual({ ok: true });
    const h = new PointsLimiter();
    let t = 0;
    let taken = 0;
    for (let m = 0; m < 60; m++, t += 61_000) for (let i = 0; i < 12; i++) if (h.tryTake(5, t).ok) taken++;
    expect(taken * 5).toBeLessThanOrEqual(500 + 60); // sliding hour window
    const r = new PointsLimiter();
    for (let i = 0; i < 30; i++) expect(r.tryTake(1, 0).ok).toBe(true);
    expect(r.tryTake(1, 0).ok).toBe(false);
  });

  it('backoff is exponential with full jitter and capped', () => {
    expect(backoffMs(1, 1000, 60_000, 0)).toBe(500);
    expect(backoffMs(1, 1000, 60_000, 1)).toBe(1000);
    expect(backoffMs(4, 1000, 60_000, 1)).toBe(8000);
    expect(backoffMs(20, 1000, 60_000, 1)).toBe(60_000);
    expect(backoffMs(20, 1000, 60_000, 0)).toBe(30_000);
  });
});

class Crash extends Error {}

/** Wraps a queue so chosen calls throw (simulating the process dying at that point). */
function crashing(inner: WriteQueue, shouldCrash: (method: string) => boolean): WriteQueue {
  return new Proxy(inner, {
    get(target, prop) {
      const v = (target as never)[prop];
      if (typeof v !== 'function') return v;
      return async (...args: unknown[]) => {
        if (typeof prop === 'string' && shouldCrash(prop)) throw new Crash(`died in ${prop}`);
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

describe('crash and restart recovery: accepted writes are never lost', () => {
  const newWorker = (
    queue: WriteQueue,
    adapter: HttpWalrusAdapter,
    clock: Clock,
    id: string,
    leaseMs = 60_000,
  ) => new WriteWorker({ queue, adapter, workerId: id, now: clock.now, leaseMs, random: () => 0.5 });

  it('dies after the relayer accepted but before the job id was recorded: reconciled, not duplicated', async () => {
    const base = new InMemoryWriteQueue();
    const { svc, clock, mock, adapter } = await rig({ queue: base, relayer: { autoCompleteMs: 0 } });
    await svc.accept(jobInput(1));
    const dying = newWorker(
      crashing(base, (m) => m === 'markSubmitted'),
      adapter,
      clock,
      'w1',
    );
    await expect(dying.tick()).rejects.toBeInstanceOf(Crash);
    expect(mock.writeItems).toBe(1);
    expect(base.snapshot()[0]!.state).toBe('submitting');

    clock.advance(61_000); // lease expires; "restart" with a fresh worker on the same durable queue
    const report = await newWorker(base, adapter, clock, 'w2').tick();
    expect(report.reconciled).toBe(1);
    expect(mock.writeItems).toBe(1);
    expect((await base.stats(clock.now())).stored).toBe(1);
  });

  it('dies before the request reaches the relayer: resubmitted exactly once', async () => {
    const base = new InMemoryWriteQueue();
    const { svc, clock, mock, adapter } = await rig({ queue: base, relayer: { autoCompleteMs: 0 } });
    await svc.accept(jobInput(1));
    await base.leaseSubmittable(clock.now(), 'w1', 60_000, 20); // leased, then the process vanished
    clock.advance(61_000);
    const w2 = newWorker(base, adapter, clock, 'w2');
    const first = await w2.tick();
    expect(first.reconciled).toBe(0);
    await drain(w2, clock, 4);
    expect(mock.writeItems).toBe(1);
    expect((await base.stats(clock.now())).stored).toBe(1);
  });

  it('survives a process restart on a Postgres-backed queue', async () => {
    const db = new PGlite();
    await db.exec(WRITE_JOBS_DDL);
    const sql = { query: (q: string, p?: unknown[]) => db.query(q, p) as never };
    const clock = new Clock();
    const mock = await MockRelayer.start({ now: clock.now, autoCompleteMs: 0 });
    open.push(mock);
    const adapter = new HttpWalrusAdapter({
      baseUrl: mock.url,
      accountId: 'a',
      signer: new Ed25519Signer('22'.repeat(32)),
      now: clock.now,
    });
    const svc = new WriteService(new PgWriteQueue(sql), clock.now, rng(5).bytes);
    for (let i = 0; i < 4; i++) await svc.accept(jobInput(i, { agent: `a${i}` }));
    // "process 1" is gone; "process 2" opens a new queue handle on the same database
    const q2 = new PgWriteQueue(sql);
    await drain(newWorker(q2, adapter, clock, 'w2'), clock, 6);
    expect((await q2.stats(clock.now())).stored).toBe(4);
    expect(mock.writeItems).toBe(4);
  });

  it('chaos: random crashes between any two queue operations never lose or duplicate an accepted write', async () => {
    const base = new InMemoryWriteQueue();
    const { clock, mock, adapter } = await rig({ queue: base, relayer: { autoCompleteMs: 0 } });
    const roomy = {
      ...deriveBudgets(),
      perAgentPerMinute: 999,
      perAgentPerHour: 999,
      perProjectPerMinute: 999,
      perProjectPerHour: 999,
      maxBacklog: 999,
    };
    const svc = new WriteService(base, clock.now, rng(4).bytes, roomy);
    const accepted: string[] = [];
    for (let i = 0; i < 40; i++) {
      const input = jobInput(i, { agent: `agent${i % 7}` });
      const r = await svc.accept(input);
      if (r.ok) accepted.push(input.text);
    }
    expect(accepted.length).toBe(40);
    const dice = rng(99);
    let crashes = 0;
    for (let iter = 0; iter < 1500; iter++) {
      const q = crashing(base, () => dice.next() < 0.2);
      try {
        await newWorker(q, adapter, clock, `w${iter}`, 5_000).tick();
      } catch (e) {
        if (!(e instanceof Crash)) throw e;
        crashes++;
      }
      clock.advance(6_000);
      const s = await base.stats(clock.now());
      if (s.stored + s.dead === accepted.length) break;
    }
    expect(crashes).toBeGreaterThan(3);
    const s = await base.stats(clock.now());
    expect(s.dead).toBe(0);
    expect(s.stored).toBe(accepted.length);
    const onRelayer = mock.blobs.map((b) => b.text);
    for (const text of accepted) expect(onRelayer.filter((t) => t === text).length, text).toBe(1);
  });
});
