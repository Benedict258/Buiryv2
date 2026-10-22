import type { WriteQueue } from './queue.js';

/** Public-relayer limits (docs-derived inputs, see ASSUMPTIONS A6). */
export interface RelayerLimits {
  pointsPerMinute: number;
  pointsPerHour: number;
  requestsPerMinutePerKey: number;
  rememberPoints: number;
  /** ASSUMED: bulk weight is rememberPoints per item (A6). */
  bulkPointsPerItem: number;
}

export const PUBLIC_RELAYER_LIMITS: RelayerLimits = {
  pointsPerMinute: 60,
  pointsPerHour: 500,
  requestsPerMinutePerKey: 30,
  rememberPoints: 5,
  bulkPointsPerItem: 5,
};

export function writePoints(limits: RelayerLimits, items: number): number {
  return items <= 1 ? limits.rememberPoints : items * limits.bulkPointsPerItem;
}

const MIN = 60_000;
const HOUR = 3_600_000;

/** Sliding-window limiter over weighted points; shared by all drains in this process. */
export class PointsLimiter {
  private events: { at: number; points: number }[] = [];

  constructor(private readonly limits: RelayerLimits = PUBLIC_RELAYER_LIMITS) {}

  private prune(now: number): void {
    this.events = this.events.filter((e) => now - e.at < HOUR);
  }

  private used(now: number): { minute: number; hour: number; requests: number } {
    let minute = 0;
    let hour = 0;
    let requests = 0;
    for (const e of this.events) {
      hour += e.points;
      if (now - e.at < MIN) {
        minute += e.points;
        requests += 1;
      }
    }
    return { minute, hour, requests };
  }

  /** Remaining points right now (minimum across windows). */
  available(now: number): number {
    this.prune(now);
    const u = this.used(now);
    if (u.requests >= this.limits.requestsPerMinutePerKey) return 0;
    return Math.max(0, Math.min(this.limits.pointsPerMinute - u.minute, this.limits.pointsPerHour - u.hour));
  }

  tryTake(points: number, now: number): { ok: true } | { ok: false; retryAfterMs: number } {
    if (this.available(now) >= points) {
      this.events.push({ at: now, points });
      return { ok: true };
    }
    const oldest = this.events.find((e) => now - e.at < MIN);
    return { ok: false, retryAfterMs: oldest ? Math.max(1000, MIN - (now - oldest.at)) : MIN };
  }
}

export interface AdmissionBudgets {
  perAgentPerMinute: number;
  perAgentPerHour: number;
  perProjectPerMinute: number;
  perProjectPerHour: number;
  /** Queued + in-flight jobs beyond which new writes are refused (backpressure). */
  maxBacklog: number;
}

/** Defaults derived from the relayer limits: one account is shared by all tenants. */
export function deriveBudgets(limits: RelayerLimits = PUBLIC_RELAYER_LIMITS): AdmissionBudgets {
  const perMin = Math.floor(limits.pointsPerMinute / limits.rememberPoints);
  const perHour = Math.floor(limits.pointsPerHour / limits.rememberPoints);
  return {
    perAgentPerMinute: Math.max(1, Math.floor(perMin / 2)),
    perAgentPerHour: Math.max(1, Math.floor(perHour / 2)),
    perProjectPerMinute: perMin,
    perProjectPerHour: perHour,
    maxBacklog: perHour * 2,
  };
}

export type AdmissionResult =
  { ok: true } | { ok: false; scope: 'agent' | 'project' | 'backlog'; retryAfterMs: number; message: string };

export async function checkAdmission(
  queue: WriteQueue,
  b: AdmissionBudgets,
  who: { agentId: string; projectId: string },
  now: number,
): Promise<AdmissionResult> {
  const stats = await queue.stats(now);
  if (stats.queued + stats.submitting + stats.submitted >= b.maxBacklog) {
    return {
      ok: false,
      scope: 'backlog',
      retryAfterMs: MIN,
      message: 'write backlog is full; storage is catching up',
    };
  }
  const checks: ['agent' | 'project', number, number, { agentId?: string; projectId?: string }][] = [
    ['agent', b.perAgentPerMinute, MIN, { agentId: who.agentId }],
    ['agent', b.perAgentPerHour, HOUR, { agentId: who.agentId }],
    ['project', b.perProjectPerMinute, MIN, { projectId: who.projectId }],
    ['project', b.perProjectPerHour, HOUR, { projectId: who.projectId }],
  ];
  for (const [scope, limit, window, filter] of checks) {
    const n = await queue.countCreatedSince(now - window, filter);
    if (n >= limit) {
      return {
        ok: false,
        scope,
        retryAfterMs: Math.min(window, MIN),
        message: `${scope} write budget exceeded (${limit} per ${window === MIN ? 'minute' : 'hour'})`,
      };
    }
  }
  return { ok: true };
}
