/**
 * Write etiquette for live runs (Phase 10 F4), following the relayer's own guidance: "keep polling a job; do not
 * resubmit unless the job reaches failed; retry after a few minutes."
 *
 * - One account at a time: the next account's write starts only once the previous write is terminal, or past its
 *   deadline.
 * - Relayer health is checked before each write; if writes are not `ok`, the run is skipped (not run into a known
 *   failure).
 * - Retries are the write drain's (F1): at least 10 minutes, doubling, with jitter; no hour holds more than three
 *   attempts. With the default 65-minute deadline a write sees at most three attempts.
 * Pure: the caller supplies health, write, tick, terminal state and the clock.
 */

export interface RelayerHealthLike {
  reachable: boolean;
  writeState: 'ok' | 'degraded' | 'paused';
}

export function healthAllowsWrite(h: RelayerHealthLike): boolean {
  return h.reachable && h.writeState === 'ok';
}

export interface AccountWriter {
  label: string;
  health: () => Promise<RelayerHealthLike>;
  /** Writes one memory; returns its memory id. */
  write: () => Promise<string>;
}

export interface WriteIo {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** One write-drain cycle. */
  tick: () => Promise<void>;
  /** The memory's terminal write state, or null while it is still in flight. */
  terminal: (memoryId: string) => Promise<'stored' | 'dead' | null>;
}

export interface AccountResult {
  label: string;
  memoryId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  final: 'stored' | 'dead' | 'not_stored_by_deadline' | 'skipped_degraded';
  health: RelayerHealthLike | null;
}

export interface SequentialResult {
  outcome: 'completed' | 'skipped_degraded';
  accounts: AccountResult[];
}

export async function runSequentialWrites(
  accounts: AccountWriter[],
  io: WriteIo,
  o: { deadlineMs?: number; pollMs?: number } = {},
): Promise<SequentialResult> {
  const deadlineMs = o.deadlineMs ?? 65 * 60_000;
  const pollMs = o.pollMs ?? 15_000;
  const results: AccountResult[] = [];
  let skipped = false;
  for (const a of accounts) {
    if (skipped) {
      results.push({
        label: a.label,
        memoryId: null,
        startedAt: null,
        endedAt: null,
        final: 'skipped_degraded',
        health: null,
      });
      continue;
    }
    const h = await a.health();
    if (!healthAllowsWrite(h)) {
      skipped = true;
      results.push({
        label: a.label,
        memoryId: null,
        startedAt: null,
        endedAt: null,
        final: 'skipped_degraded',
        health: h,
      });
      continue;
    }
    const startedAt = io.now();
    const memoryId = await a.write();
    let final: AccountResult['final'] = 'not_stored_by_deadline';
    while (io.now() - startedAt < deadlineMs) {
      await io.tick();
      const t = await io.terminal(memoryId);
      if (t) {
        final = t;
        break;
      }
      await io.sleep(pollMs);
    }
    results.push({ label: a.label, memoryId, startedAt, endedAt: io.now(), final, health: h });
  }
  return { outcome: skipped ? 'skipped_degraded' : 'completed', accounts: results };
}

/** I1's fixed window (criteria written before run 1): a write counts as stored only if it was stored within 4 minutes. */
export const I1_WINDOW_MS = 4 * 60_000;

export function storedWithin(r: AccountResult, windowMs = I1_WINDOW_MS): boolean {
  return (
    r.final === 'stored' && r.startedAt !== null && r.endedAt !== null && r.endedAt - r.startedAt <= windowMs
  );
}

/**
 * Drain options for an isolation run (Phase 10 F6): exactly one attempt per account. A failed attempt is final for
 * the run (the job goes dead), so nothing retries in the background into the next account's phase. Retry behaviour
 * is tested separately by the drain's own tests.
 */
export const ISOLATION_DRAIN_OPTIONS = { maxAttempts: 1, pollIntervalMs: 15_000 } as const;

/** How long a run waits for one attempt to reach a terminal state (the relayer fails or finishes a job in minutes). */
export const TERMINAL_WAIT_MS = 20 * 60_000;
