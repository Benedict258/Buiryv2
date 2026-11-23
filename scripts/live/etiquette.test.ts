import { describe, expect, it } from 'vitest';
import { healthAllowsWrite, runSequentialWrites, type AccountWriter } from './etiquette.js';

// Phase 10 F4: live writes follow the relayer's guidance. One account at a time, each write waited on to a terminal
// state; health checked before each write and the run skipped while writes are degraded. Fakes only, no network.

type H = { reachable: boolean; writeState: 'ok' | 'degraded' | 'paused' };

function fakes(health: Record<string, H[]>, finishAfterTicks: Record<string, number | 'never'>) {
  const events: string[] = [];
  let t = 0;
  const written = new Map<string, number>();
  const accounts: AccountWriter[] = Object.keys(health).map((label) => ({
    label,
    health: async () => {
      const h = health[label]!.shift() ?? { reachable: true, writeState: 'ok' };
      events.push(`health ${label} ${h.writeState}`);
      return h;
    },
    write: async () => {
      events.push(`write ${label}`);
      written.set(`mem_${label}`, 0);
      return `mem_${label}`;
    },
  }));
  return {
    events,
    accounts,
    io: {
      now: () => t,
      sleep: async (ms: number) => void (t += ms),
      tick: async () => {
        for (const [m, n] of written) written.set(m, n + 1);
        events.push('tick');
      },
      terminal: async (memoryId: string) => {
        const label = memoryId.slice(4);
        const need = finishAfterTicks[label]!;
        return need !== 'never' && (written.get(memoryId) ?? 0) >= need ? ('stored' as const) : null;
      },
    },
  };
}

describe('live write etiquette', () => {
  it('writes only while the relayer reports writes ok', () => {
    expect(healthAllowsWrite({ reachable: true, writeState: 'ok' })).toBe(true);
    expect(healthAllowsWrite({ reachable: true, writeState: 'degraded' })).toBe(false);
    expect(healthAllowsWrite({ reachable: true, writeState: 'paused' })).toBe(false);
    expect(healthAllowsWrite({ reachable: false, writeState: 'ok' })).toBe(false);
  });

  it("one account at a time: B is written only after A's write reached a terminal state", async () => {
    const f = fakes({ A: [], B: [] }, { A: 3, B: 2 });
    const r = await runSequentialWrites(f.accounts, f.io, { deadlineMs: 60_000, pollMs: 15_000 });
    expect(r.outcome).toBe('completed');
    expect(r.accounts.map((a) => [a.label, a.final])).toEqual([
      ['A', 'stored'],
      ['B', 'stored'],
    ]);
    const firstB = f.events.indexOf('write B');
    const aDone = f.events.lastIndexOf('tick', firstB);
    expect(f.events.indexOf('write A')).toBeLessThan(aDone);
    expect(f.events.slice(0, firstB).filter((e) => e.startsWith('write')).length).toBe(1);
  });

  it('skips the whole run when writes are degraded before the first write; nothing is written', async () => {
    const f = fakes({ A: [{ reachable: true, writeState: 'degraded' }], B: [] }, { A: 1, B: 1 });
    const r = await runSequentialWrites(f.accounts, f.io, { deadlineMs: 60_000, pollMs: 15_000 });
    expect(r.outcome).toBe('skipped_degraded');
    expect(f.events.filter((e) => e.startsWith('write'))).toEqual([]);
  });

  it('skips the rest of the run when writes turn degraded before the second write', async () => {
    const f = fakes({ A: [], B: [{ reachable: true, writeState: 'degraded' }] }, { A: 1, B: 1 });
    const r = await runSequentialWrites(f.accounts, f.io, { deadlineMs: 60_000, pollMs: 15_000 });
    expect(r.outcome).toBe('skipped_degraded');
    expect(r.accounts.map((a) => [a.label, a.final])).toEqual([
      ['A', 'stored'],
      ['B', 'skipped_degraded'],
    ]);
    expect(f.events).not.toContain('write B');
  });

  it('an account whose write does not finish by the deadline is recorded as not stored; the next waits for it', async () => {
    const f = fakes({ A: [], B: [] }, { A: 'never', B: 1 });
    const r = await runSequentialWrites(f.accounts, f.io, { deadlineMs: 65 * 60_000, pollMs: 60_000 });
    expect(r.accounts[0]).toMatchObject({ label: 'A', final: 'not_stored_by_deadline' });
    expect(r.accounts[1]!.startedAt).toBeGreaterThanOrEqual(65 * 60_000);
  });
});

describe('F6: isolation runs make exactly one attempt per account and score I1 at 4 minutes', () => {
  it('I1 counts a write as stored only if it was stored within the fixed 4-minute window', async () => {
    const { storedWithin, I1_WINDOW_MS } = await import('./etiquette.js');
    expect(I1_WINDOW_MS).toBe(4 * 60_000);
    const r = (final: string, startedAt: number, endedAt: number) =>
      ({ label: 'A', memoryId: 'm', startedAt, endedAt, final, health: null }) as never;
    expect(storedWithin(r('stored', 0, 3 * 60_000))).toBe(true);
    expect(storedWithin(r('stored', 0, 5 * 60_000))).toBe(false);
    expect(storedWithin(r('dead', 0, 60_000))).toBe(false);
  });

  it('the isolation drain options make one attempt and no background retry', async () => {
    const { ISOLATION_DRAIN_OPTIONS } = await import('./etiquette.js');
    const { MockRelayer, HttpWalrusAdapter, Ed25519Signer, InMemoryWriteQueue, WriteService, WriteWorker } =
      await import('../../packages/storage/src/index.js');
    let now = 1_800_000_000_000;
    const mock = await MockRelayer.start({ now: () => now });
    try {
      const adapter = new HttpWalrusAdapter({
        baseUrl: mock.url,
        accountId: '0xa',
        signer: new Ed25519Signer('22'.repeat(32)),
        now: () => now,
      });
      const queue = new InMemoryWriteQueue();
      const svc = new WriteService(
        queue,
        () => now,
        (n: number) => new Uint8Array(n).fill(7),
      );
      const w = new WriteWorker({
        queue,
        adapter,
        workerId: 'iso',
        now: () => now,
        ...ISOLATION_DRAIN_OPTIONS,
      });
      await svc.accept({
        memoryId: 'mem_x',
        namespace: 'buiry.v1.prj_x.main',
        projectId: 'prj_x',
        agentId: 'a',
        header: 'h',
        text: 'h\nbody',
      });
      mock.failNextJobs(100, 'temporary capacity limit');
      let submitted = 0;
      for (let i = 0; i < 480; i++) {
        submitted += (await w.tick()).submitted; // two hours of ticks
        now += 15_000;
      }
      expect(submitted).toBe(1);
      expect(queue.snapshot()[0]!.state).toBe('dead');
    } finally {
      await mock.close();
    }
  });
});
