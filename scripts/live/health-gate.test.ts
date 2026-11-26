import { describe, expect, it, vi } from 'vitest';
import {
  HEALTHY_IN_A_ROW,
  HEALTH_INTERVAL_MS,
  HEALTH_POLLS,
  gatedWrites,
  healthText,
  waitForHealthyRelayers,
  writeEventLine,
  type HealthLike,
} from './health-gate.js';

// Phase 14d: before the isolation run's first write, both relayers must report healthy on two consecutive read-only
// polls (at most 10, 60 s apart); otherwise the run stops with zero writes queued or sent. Every secret is MADE UP.

const OK: HealthLike = { reachable: true, writeState: 'ok' };
const DOWN: HealthLike = {
  reachable: false,
  writeState: 'paused',
  error: { kind: 'unavailable', cause: 'ECONNRESET' },
};
const seq = (states: HealthLike[]) => {
  let i = 0;
  return vi.fn(async (): Promise<HealthLike> => states[Math.min(i++, states.length - 1)]!);
};

describe('waitForHealthyRelayers', () => {
  it('uses at most 10 polls, 60 s apart, and needs 2 healthy in a row', () => {
    expect(HEALTH_POLLS).toBe(10);
    expect(HEALTH_INTERVAL_MS).toBe(60_000);
    expect(HEALTHY_IN_A_ROW).toBe(2);
  });

  it('proceeds after two consecutive polls where both are healthy, sleeping 60 s between polls only', async () => {
    const sleep = vi.fn(async () => {});
    const a = seq([OK]);
    const b = seq([OK]);
    const g = await waitForHealthyRelayers(
      [
        { label: 'A', health: a },
        { label: 'B', health: b },
      ],
      { sleep },
    );
    expect(g.ok).toBe(true);
    expect(g.polls).toBe(2);
    expect(sleep.mock.calls).toEqual([[60_000]]);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('stops after 10 polls when one relayer is unhealthy throughout, naming it, and writes nothing', async () => {
    const write = vi.fn(async () => 'written');
    const lines: string[] = [];
    const out = await gatedWrites(
      () =>
        waitForHealthyRelayers(
          [
            { label: 'A', health: seq([OK]) },
            { label: 'B', health: seq([DOWN]) },
          ],
          { sleep: async () => {}, say: (l) => lines.push(l) },
        ),
      write,
    );
    expect(write).not.toHaveBeenCalled();
    expect(out.result).toBeUndefined();
    expect(out.gate.ok).toBe(false);
    expect(out.gate.polls).toBe(10);
    if (!out.gate.ok) {
      expect(out.gate.failing).toEqual(['B']);
      expect(out.gate.reason).toBe(
        'relayer B not healthy in 10 polls (last: unreachable, RelayerError class=network kind=unavailable cause=ECONNRESET); no write queued or sent',
      );
    }
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe(
      'health poll 1/10: A ok; B unreachable (RelayerError class=network kind=unavailable cause=ECONNRESET)',
    );
  });

  it('after a recovery proceeds only once two consecutive polls are healthy', async () => {
    // B: down, down, ok, down, ok, ok -> the first two-in-a-row is polls 5 and 6.
    const write = vi.fn(async () => 'written');
    const out = await gatedWrites(
      () =>
        waitForHealthyRelayers(
          [
            { label: 'A', health: seq([OK]) },
            { label: 'B', health: seq([DOWN, DOWN, OK, DOWN, OK, OK]) },
          ],
          { sleep: async () => {} },
        ),
      write,
    );
    expect(out.gate.ok).toBe(true);
    expect(out.gate.polls).toBe(6);
    expect(write).toHaveBeenCalledTimes(1);
    expect(out.result).toBe('written');
  });

  it('counts a degraded relayer and a thrown health check as unhealthy', async () => {
    const thrown = vi.fn(async () => {
      throw Object.assign(new Error('auth failed for key sk-made-up-SECRET-123'), {
        name: 'RelayerError',
        kind: 'auth',
        status: 401,
      });
    });
    const g = await waitForHealthyRelayers(
      [
        { label: 'A', health: seq([{ reachable: true, writeState: 'degraded' }]) },
        { label: 'B', health: thrown },
      ],
      { sleep: async () => {}, polls: 1 },
    );
    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.failing).toEqual(['A', 'B']);
      expect(g.history[0]!.states).toEqual({
        A: 'writes degraded',
        B: 'error (RelayerError class=http kind=auth status=401)',
      });
      expect(JSON.stringify(g)).not.toContain('sk-made-up');
    }
  });
});

describe('healthText and write event lines go through the error printer', () => {
  it('shows class, kind, status and cause for an unreachable relayer, and no value', () => {
    expect(
      healthText({
        reachable: false,
        writeState: 'paused',
        error: { kind: 'unavailable', status: 503 },
      }),
    ).toBe('unreachable (RelayerError class=http kind=unavailable status=503)');
    expect(healthText({ reachable: false, writeState: 'paused' })).toBe('unreachable');
    expect(healthText(OK)).toBe('ok');
  });

  it('prints a failed write job with class, kind, status and cause, never the reason text or a value', () => {
    const line = writeEventLine(
      JSON.stringify({
        event: 'write_job',
        memory: 'mem_1',
        status: 'dead',
        attempt: 1,
        reason:
          'retries exhausted: body {"key":"sk-made-up-SECRET-123"} https://relayer.example.test/?token=t',
        error: { kind: 'unavailable', status: 502, cause: 'ECONNRESET' },
      }),
      { label: 'A', elapsedSec: 17, at: '2026-11-26T10:32:29Z' },
    );
    expect(line).toBe(
      '2026-11-26T10:32:29Z account A job - status dead attempt 1 +17s (RelayerError class=http kind=unavailable status=502 cause=ECONNRESET)',
    );
    for (const s of ['sk-made-up', 'relayer.example.test', 'token', 'retries exhausted'])
      expect(line).not.toContain(s);
  });

  it('prints a non-failure event without an error part, and ignores other events', () => {
    expect(
      writeEventLine(
        JSON.stringify({
          event: 'write_job',
          memory: 'mem_1',
          relayerJob: '128fd62b-d937-48ff-a819-1e26eb31b740',
          status: 'submitted',
          attempt: 1,
        }),
        {
          label: 'B',
          elapsedSec: 2,
          at: '2026-11-26T10:33:00Z',
        },
      ),
    ).toBe(
      '2026-11-26T10:33:00Z account B job 128fd62b-d937-48ff-a819-1e26eb31b740 status submitted attempt 1 +2s',
    );
    expect(
      writeEventLine(JSON.stringify({ event: 'other' }), { label: 'A', elapsedSec: 0, at: 'x' }),
    ).toBeNull();
  });
});
