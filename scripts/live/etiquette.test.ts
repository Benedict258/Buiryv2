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
