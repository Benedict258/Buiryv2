import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { InMemoryWriteQueue, PgWriteQueue, WRITE_JOBS_DDL, type WriteQueue } from '../src/index.js';
import { jobInput } from './helpers.js';

async function pgQueue(): Promise<WriteQueue> {
  const db = new PGlite();
  await db.exec(WRITE_JOBS_DDL);
  return new PgWriteQueue({ query: (sql, params) => db.query(sql, params as unknown[]) as never });
}

describe.each<[string, () => Promise<WriteQueue>]>([
  ['in-memory', async () => new InMemoryWriteQueue()],
  ['postgres (PGlite)', pgQueue],
])('WriteQueue contract: %s', (_name, make) => {
  const enq = (q: WriteQueue, i: number, at = 1000 + i, o = {}) =>
    q.enqueue({ id: `job_${i}`, ...jobInput(i, o), idempotencyKey: `k${i}`, at });

  it('is idempotent on the key', async () => {
    const q = await make();
    const a = await enq(q, 1);
    const b = await q.enqueue({ ...jobInput(1), id: 'job_other', idempotencyKey: 'k1', at: 5000 });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.job.id).toBe('job_1');
    expect((await q.findByKey('k1'))?.id).toBe('job_1');
    expect(await q.findByKey('nope')).toBeNull();
  });

  it('leases ready jobs of a single namespace in creation order, up to max', async () => {
    const q = await make();
    for (let i = 1; i <= 3; i++) await enq(q, i);
    await enq(q, 4, 2000, { namespace: 'buiry.v1.prj_other00000001.main' });
    const l = await q.leaseSubmittable(5000, 'w1', 60_000, 2);
    expect(l.ready.map((j) => j.id)).toEqual(['job_1', 'job_2']);
    expect(l.ready.every((j) => j.state === 'submitting' && j.attempts === 1)).toBe(true);
    const l2 = await q.leaseSubmittable(5001, 'w2', 60_000, 20);
    expect(l2.ready.map((j) => j.id)).toEqual(['job_3']);
    const l3 = await q.leaseSubmittable(5002, 'w2', 60_000, 20);
    expect(l3.ready.map((j) => j.id)).toEqual(['job_4']);
  });

  it('leases only the projects in scope (one worker per storage account)', async () => {
    const q = await make();
    const other = 'prj_own00000000000001';
    await enq(q, 1);
    await enq(q, 2, 1002, { project: other, namespace: `buiry.v1.${other}.main` });
    const managed = await q.leaseSubmittable(5000, 'managed', 60_000, 20, { exclude: [other] });
    expect(managed.ready.map((j) => j.id)).toEqual(['job_1']);
    const none = await q.leaseSubmittable(5001, 'managed', 60_000, 20, { exclude: [other] });
    expect(none.ready).toEqual([]);
    const own = await q.leaseSubmittable(5002, 'own', 60_000, 20, { only: [other] });
    expect(own.ready.map((j) => j.id)).toEqual(['job_2']);
    await q.markSubmitted('job_1', 'r1', 6000, 5003);
    await q.markSubmitted('job_2', 'r2', 6000, 5003);
    expect((await q.leasePollable(7000, 'own', 60_000, 50, { only: [other] })).map((j) => j.id)).toEqual([
      'job_2',
    ]);
    expect(
      (await q.leasePollable(7001, 'managed', 60_000, 50, { exclude: [other] })).map((j) => j.id),
    ).toEqual(['job_1']);
  });

  it('does not hand a leased job to a second worker, and reports expired-lease submitting jobs as uncertain', async () => {
    const q = await make();
    await enq(q, 1);
    await q.leaseSubmittable(5000, 'w1', 1000, 5);
    const during = await q.leaseSubmittable(5500, 'w2', 1000, 5);
    expect(during.ready).toEqual([]);
    expect(during.uncertain).toEqual([]);
    const after = await q.leaseSubmittable(7000, 'w2', 1000, 5);
    expect(after.uncertain.map((j) => j.id)).toEqual(['job_1']);
    expect(after.ready).toEqual([]);
  });

  it('walks the lifecycle submit -> poll -> stored', async () => {
    const q = await make();
    await enq(q, 1);
    await q.leaseSubmittable(2000, 'w', 1000, 5);
    await q.markSubmitted('job_1', 'rj1', 3000, 2100);
    expect(await q.leasePollable(2500, 'w', 1000, 5)).toEqual([]);
    const due = await q.leasePollable(3000, 'w', 1000, 5);
    expect(due.map((j) => j.relayerJobId)).toEqual(['rj1']);
    await q.schedulePoll('job_1', 4000, 3100);
    expect(await q.leasePollable(3500, 'w', 1000, 5)).toEqual([]);
    await q.markStored('job_1', 'blob1', 4100);
    expect(await q.get('job_1')).toMatchObject({ state: 'stored', blobId: 'blob1', leaseUntil: null });
  });

  it('retries with delay, dead-letters, requeues, and reports stats', async () => {
    const q = await make();
    await enq(q, 1);
    await enq(q, 2);
    await q.leaseSubmittable(2000, 'w', 1000, 5);
    await q.scheduleRetry('job_1', 'unavailable', 10_000, 2100);
    await q.markDead('job_2', 'auth: nope', 2100);
    expect(await q.leaseSubmittable(5000, 'w', 1000, 5)).toEqual({ ready: [], uncertain: [] });
    expect((await q.leaseSubmittable(10_000, 'w', 1000, 5)).ready.map((j) => j.id)).toEqual(['job_1']);
    const s = await q.stats(20_000);
    expect(s).toMatchObject({ submitting: 1, dead: 1 });
    expect(s.oldestPendingAgeMs).toBe(20_000 - 1001);
    expect((await q.listDead(10)).map((j) => j.id)).toEqual(['job_2']);
    await q.requeue('job_2', 21_000);
    expect(await q.get('job_2')).toMatchObject({ state: 'queued', attempts: 0 });
  });

  it('counts created jobs per agent and project in a window', async () => {
    const q = await make();
    await enq(q, 1, 1000, { agent: 'a1' });
    await enq(q, 2, 2000, { agent: 'a1' });
    await enq(q, 3, 3000, { agent: 'a2', project: 'prj_other00000001' });
    expect(await q.countCreatedSince(0, { agentId: 'a1' })).toBe(2);
    expect(await q.countCreatedSince(1500, { agentId: 'a1' })).toBe(1);
    expect(await q.countCreatedSince(0, { projectId: 'prj_other00000001' })).toBe(1);
    expect(await q.countCreatedSince(0, {})).toBe(3);
  });
});
