import { afterEach, describe, expect, it } from 'vitest';
import {
  Ed25519Signer,
  HttpWalrusAdapter,
  InMemoryWriteQueue,
  MockRelayer,
  WriteService,
  WriteWorker,
  relayerBackoffMs,
} from '../src/index.js';
import { Clock, jobInput, rng } from './helpers.js';

// Phase 10 F1, F2 and job-id logging: the write drain follows the relayer's own guidance ("keep polling a job; do not
// resubmit unless it reaches failed; retry after a few minutes"), pauses while the relayer reports writes degraded,
// records a content-free reason, and logs relayer job ids without content.

const MIN = 60_000;
const CAPACITY =
  'The hosted relayer could not complete the durable Walrus upload: temporary capacity limit on Walrus Memory infrastructure. Contact support at https://support.example.test?ref=SECRET-REF';

const open: MockRelayer[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function rig(worker: object = {}) {
  const clock = new Clock();
  const mock = await MockRelayer.start({ now: clock.now });
  open.push(mock);
  const adapter = new HttpWalrusAdapter({
    baseUrl: mock.url,
    accountId: '0xacct',
    signer: new Ed25519Signer('22'.repeat(32)),
    now: clock.now,
  });
  const queue = new InMemoryWriteQueue();
  const r = rng(11);
  const logs: string[] = [];
  const stored: string[] = [];
  const w = new WriteWorker({
    queue,
    adapter,
    workerId: 'w1',
    now: clock.now,
    random: r.next,
    log: (l: string) => void logs.push(l),
    onStored: (j, b) => void stored.push(`${j.id}:${b}`),
    ...worker,
  });
  const svc = new WriteService(queue, clock.now, r.bytes);
  return { clock, mock, queue, w, svc, logs, stored };
}

/** Ticks every `step` ms for `total` ms, recording the clock time of each submission. */
async function run(x: Awaited<ReturnType<typeof rig>>, total: number, step = 15_000) {
  const submits: number[] = [];
  for (let t = 0; t < total; t += step) {
    const r = await x.w.tick();
    for (let i = 0; i < r.submitted; i++) submits.push(x.clock.now());
    x.clock.advance(step);
  }
  return submits;
}

describe('F1: retry timing respects the relayer', () => {
  it('backoff waits several minutes, doubles, never goes below its floor, and is capped', () => {
    for (const rand of [0, 0.5, 0.999]) {
      expect(relayerBackoffMs(1, 10 * MIN, 120 * MIN, rand)).toBeGreaterThanOrEqual(10 * MIN);
      expect(relayerBackoffMs(2, 10 * MIN, 120 * MIN, rand)).toBeGreaterThanOrEqual(20 * MIN);
      expect(relayerBackoffMs(9, 10 * MIN, 120 * MIN, rand)).toBeLessThanOrEqual(120 * MIN * 1.25);
    }
    expect(relayerBackoffMs(1, 10 * MIN, 120 * MIN, 0)).toBeLessThan(
      relayerBackoffMs(1, 10 * MIN, 120 * MIN, 0.999),
    );
  });

  it('a failed relayer job is not resubmitted within 5 minutes', async () => {
    const x = await rig();
    await x.svc.accept(jobInput(1));
    x.mock.failNextJobs(1, CAPACITY);
    const submits = await run(x, 9 * MIN);
    expect(submits).toHaveLength(1); // the first submission only; no resubmission inside 9 minutes
  });

  it('under continuous failure: never more than 3 attempts in any hour, growing waits, then the existing give-up', async () => {
    const x = await rig();
    await x.svc.accept(jobInput(1));
    x.mock.failNextJobs(100, CAPACITY);
    const submits = await run(x, 8 * 60 * MIN, 30_000);
    for (const s of submits)
      expect(submits.filter((t) => t >= s && t < s + 60 * MIN).length).toBeLessThanOrEqual(3);
    const gaps = submits.slice(1).map((t, i) => t - submits[i]!);
    for (const [i, g] of gaps.entries()) {
      expect(g).toBeGreaterThanOrEqual(5 * MIN);
      if (i > 0 && g < 120 * MIN) expect(g).toBeGreaterThan(gaps[i - 1]!);
    }
    const job = (await x.queue.listDead(5))[0];
    expect(job?.attempts).toBe(6); // existing give-up: 6 attempts, then dead
    expect(x.stored).toEqual([]); // never marked stored without a finished relayer job
  });

  it('pauses submissions while the relayer reports writes degraded, but keeps polling jobs already submitted', async () => {
    const x = await rig();
    await x.svc.accept(jobInput(1));
    expect((await x.w.tick()).submitted).toBe(1);
    await x.svc.accept(jobInput(2));
    x.mock.writeState = 'degraded';
    x.clock.advance(3000);
    let r = await x.w.tick();
    expect(r).toMatchObject({ relayer: 'degraded', submitted: 0, skipped: 'degraded' });
    for (let i = 0; i < 10 && x.stored.length === 0; i++) {
      x.clock.advance(3000);
      r = await x.w.tick();
      expect(r.submitted).toBe(0);
    }
    expect(x.stored).toHaveLength(1); // job 1 finished while degraded: polling continued
    x.mock.writeState = 'ok';
    x.clock.advance(3000);
    expect((await x.w.tick()).submitted).toBe(1); // job 2 goes once writes recover
  });
});

describe('F2: the failure reason is the real one, content-free', () => {
  it('a capacity-limited job records "relayer reachable, capacity limit reported", with no relayer text', async () => {
    const x = await rig();
    await x.svc.accept(jobInput(1));
    x.mock.failNextJobs(1, CAPACITY);
    await run(x, 2 * MIN);
    const j = x.queue.snapshot()[0]!;
    expect(j.lastError).toBe(
      'job_failed: the storage relayer was reachable and reported a temporary capacity limit',
    );
    expect(j.lastError).not.toMatch(/unreachable|support|SECRET|https?:/);
  });

  it('any other failed job records "relayer reachable, job failed", not "unreachable"', async () => {
    const x = await rig();
    await x.svc.accept(jobInput(1));
    x.mock.failNextJobs(1);
    await run(x, 2 * MIN);
    const j = x.queue.snapshot()[0]!;
    expect(j.lastError).toBe(
      'job_failed: the storage relayer was reachable and reported the write job as failed',
    );
  });
});

describe('job-id logging (content-free)', () => {
  it('logs the relayer job id and every status change, without memory text or namespace', async () => {
    const x = await rig();
    await x.svc.accept(jobInput(1));
    x.mock.failNextJobs(1, CAPACITY);
    await run(x, 2 * MIN, 1000);
    const lines = x.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
    const jobLines = lines.filter((l) => l.event === 'write_job');
    expect(jobLines.length).toBeGreaterThanOrEqual(2);
    for (const l of jobLines) {
      expect(typeof l.relayerJob).toBe('string');
      expect(typeof l.at).toBe('string');
      expect(l).toHaveProperty('status');
      expect(l).toHaveProperty('attempt');
    }
    expect(jobLines.map((l) => l.status)).toEqual(expect.arrayContaining(['submitted', 'failed']));
    const all = x.logs.join('\n');
    expect(all).not.toContain('SECRET');
    expect(all).not.toContain('capacity limit on Walrus'); // the relayer's text never reaches the log
    expect(all).not.toMatch(/buiry\.v1\./); // no namespace
    expect(all).not.toContain(jobInput(1).text);
  });
});
