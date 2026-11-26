/**
 * Phase 14d: the isolation run's pre-write health gate, and the write-event line printer. Pure: the caller passes the
 * health checks and the sleep. Health is read-only (the relayer's unsigned `/health`); nothing here writes.
 *
 * The gate polls every relayer up to HEALTH_POLLS times, HEALTH_INTERVAL_MS apart, and passes only after
 * HEALTHY_IN_A_ROW consecutive polls in which every relayer is reachable and reports writes ok. Otherwise it fails,
 * naming the relayers that were not healthy at the last poll, and the run makes no write.
 */
import { errorText } from '../lib/errors.js';

export const HEALTH_POLLS = 10;
export const HEALTH_INTERVAL_MS = 60_000;
export const HEALTHY_IN_A_ROW = 2;

export interface HealthLike {
  reachable: boolean;
  writeState: string;
  error?: { kind: string; status?: number; cause?: string };
}

/** A relayer error described by its fields, printed through `errorText` (class, kind, status, cause only). */
const describedError = (d: { kind: string; status?: number; cause?: string }) =>
  errorText({
    name: 'RelayerError',
    kind: d.kind,
    ...(d.status !== undefined ? { status: d.status } : {}),
    ...(d.cause ? { netCode: d.cause } : {}),
  });

/** One relayer's health as a short line: ok, writes degraded or paused, or unreachable with the error's fields. */
export function healthText(h: HealthLike): string {
  if (!h.reachable) return h.error ? `unreachable (${describedError(h.error)})` : 'unreachable';
  return h.writeState === 'ok' ? 'ok' : `writes ${h.writeState === 'degraded' ? 'degraded' : 'paused'}`;
}

const healthy = (h: HealthLike) => h.reachable && h.writeState === 'ok';

export type GateResult =
  | { ok: true; polls: number; history: { poll: number; states: Record<string, string> }[] }
  | {
      ok: false;
      polls: number;
      history: { poll: number; states: Record<string, string> }[];
      failing: string[];
      reason: string;
    };

export async function waitForHealthyRelayers(
  relayers: { label: string; health: () => Promise<HealthLike> }[],
  o: {
    sleep: (ms: number) => Promise<void>;
    say?: (line: string) => void;
    polls?: number;
    intervalMs?: number;
  },
): Promise<GateResult> {
  const polls = o.polls ?? HEALTH_POLLS;
  const history: { poll: number; states: Record<string, string> }[] = [];
  let inARow = 0;
  let last: Record<string, boolean> = {};
  for (let p = 1; p <= polls; p++) {
    if (p > 1) await o.sleep(o.intervalMs ?? HEALTH_INTERVAL_MS);
    const states: Record<string, string> = {};
    last = {};
    for (const r of relayers) {
      try {
        const h = await r.health();
        states[r.label] = healthText(h);
        last[r.label] = healthy(h);
      } catch (e) {
        states[r.label] = `error (${errorText(e)})`;
        last[r.label] = false;
      }
    }
    history.push({ poll: p, states });
    o.say?.(`health poll ${p}/${polls}: ${relayers.map((r) => `${r.label} ${states[r.label]}`).join('; ')}`);
    inARow = relayers.every((r) => last[r.label]) ? inARow + 1 : 0;
    if (inARow >= HEALTHY_IN_A_ROW) return { ok: true, polls: p, history };
  }
  const failing = relayers.filter((r) => !last[r.label]).map((r) => r.label);
  const lastStates = history[history.length - 1]?.states ?? {};
  const reason =
    failing.length > 0
      ? `relayer ${failing.join(' and ')} not healthy in ${polls} polls (last: ${failing
          .map((l) => (lastStates[l] ?? 'unknown').replace(/^unreachable \((.*)\)$/, 'unreachable, $1'))
          .join('; ')}); no write queued or sent`
      : `relayers not healthy on ${HEALTHY_IN_A_ROW} consecutive polls in ${polls}; no write queued or sent`;
  return { ok: false, polls, history, failing, reason };
}

/** Runs `writes` only when the gate passes; otherwise returns the gate's result and nothing else happens. */
export async function gatedWrites<T>(
  gate: () => Promise<GateResult>,
  writes: () => Promise<T>,
): Promise<{ gate: GateResult; result?: T }> {
  const g = await gate();
  if (!g.ok) return { gate: g };
  return { gate: g, result: await writes() };
}

/**
 * A write-queue event (`write_job` JSON) as one line. A failure prints its error fields through `errorText`; the
 * queue's own reason text is never printed. Returns null for other events.
 */
export function writeEventLine(
  line: string,
  ctx: { label: string; elapsedSec: number | '?'; at: string },
): string | null {
  let j: {
    event?: unknown;
    memory?: unknown;
    relayerJob?: unknown;
    status?: unknown;
    attempt?: unknown;
    error?: unknown;
  };
  try {
    j = JSON.parse(line) as typeof j;
  } catch {
    return null;
  }
  if (j.event !== 'write_job' || typeof j.memory !== 'string') return null;
  const job =
    typeof j.relayerJob === 'string' && /^[0-9a-f-]{1,64}$/i.test(j.relayerJob) ? j.relayerJob : '-';
  const status = typeof j.status === 'string' && /^[a-z_]{1,32}$/.test(j.status) ? j.status : 'unrecognised';
  const attempt = typeof j.attempt === 'number' && Number.isInteger(j.attempt) ? j.attempt : '?';
  const e = j.error as { kind?: unknown; status?: unknown; cause?: unknown } | undefined;
  const err =
    e && typeof e.kind === 'string'
      ? ` (${describedError({
          kind: e.kind,
          ...(typeof e.status === 'number' ? { status: e.status } : {}),
          ...(typeof e.cause === 'string' ? { cause: e.cause } : {}),
        })})`
      : '';
  return `${ctx.at} account ${ctx.label} job ${job} status ${status} attempt ${attempt} +${ctx.elapsedSec}s${err}`;
}
