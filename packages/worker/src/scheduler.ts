import type { ServiceDeps } from '@buiry/api';

export interface ScheduledJob {
  name: string;
  intervalMs: number;
  run: () => Promise<unknown>;
}

/**
 * What a failed job leaves in logs: the error class and, for Postgres errors, the SQLSTATE code. Never the message:
 * database errors can quote row values, such as memory text (SECURITY_REVIEW M5, sweep A6).
 */
export function describeJobError(e: unknown): string {
  const err = e as { name?: unknown; code?: unknown };
  const name = typeof err?.name === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(err.name) ? err.name : typeof e;
  const code = typeof err?.code === 'string' && /^[A-Z0-9_]{1,12}$/.test(err.code) ? err.code : undefined;
  return JSON.stringify({ error: name, ...(code ? { code } : {}) });
}

/** The log line for a failed job. The job-failures alarm (infra/aws/main.tf, DEPLOYMENT.md) matches "job" and "failed". */
export function jobFailureLine(name: string, error: string | undefined): string {
  return `[buiry] job ${name} failed: ${error ?? '{}'}`;
}

/**
 * One structured line per job run (Phase 9 E2): name, outcome, duration and, on failure, the error class and code
 * from describeJobError. Alongside, not instead of, the failure line above.
 */
export function jobRunLine(r: { name: string; ok: boolean; ms: number; error?: string }): string {
  let error: unknown;
  if (!r.ok && r.error) {
    try {
      error = JSON.parse(r.error);
    } catch {
      error = { error: 'unknown' };
    }
  }
  return JSON.stringify({
    level: r.ok ? 'info' : 'error',
    event: 'job',
    name: r.name,
    ok: r.ok,
    ms: r.ms,
    ...(error !== undefined ? { error } : {}),
  });
}

export interface SchedulerTickReport {
  ran: { name: string; ok: boolean; ms: number; error?: string; result?: unknown }[];
  skipped: string[];
}

/**
 * Cron-style jobs with database leases so several worker instances run each job once per interval.
 * A lease is held for at most `leaseMs` so a crashed holder frees the job automatically.
 */
export class Scheduler {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly holder: string,
    private readonly jobs: ScheduledJob[],
    private readonly leaseMs = 5 * 60_000,
    /** A failed run is retried after this long (or its interval, if shorter), not on the very next tick. */
    private readonly retryMs = 30_000,
  ) {}

  private async acquire(j: ScheduledJob): Promise<boolean> {
    const now = this.deps.now();
    const r = await this.deps.db.system((tx) =>
      tx.query(
        `insert into job_leases (name, holder, leased_until, last_run_at) values ($1,$2,$3,null)
         on conflict (name) do update set holder = $2, leased_until = $3
           where job_leases.leased_until <= $4 and (job_leases.last_run_at is null or job_leases.last_run_at <= $5)
         returning name`,
        [j.name, this.holder, new Date(now + this.leaseMs), new Date(now), new Date(now - j.intervalMs)],
      ),
    );
    return r.rows.length > 0;
  }

  async tick(): Promise<SchedulerTickReport> {
    const rep: SchedulerTickReport = { ran: [], skipped: [] };
    for (const j of this.jobs) {
      if (!(await this.acquire(j))) {
        rep.skipped.push(j.name);
        continue;
      }
      let entry: SchedulerTickReport['ran'][number];
      const t0 = performance.now();
      try {
        const result = await j.run();
        entry = { name: j.name, ok: true, ms: Math.round(performance.now() - t0), result };
      } catch (e) {
        entry = {
          name: j.name,
          ok: false,
          ms: Math.round(performance.now() - t0),
          error: describeJobError(e),
        };
      }
      const now = new Date(this.deps.now());
      // A failed run is retried after retryMs instead of a full interval. Retrying on the very next tick turned a
      // deterministic failure into a once-a-second loop (seen live: the isolation canary on a testnet deployment).
      const lastRun = entry.ok ? now : new Date(now.getTime() - Math.max(0, j.intervalMs - this.retryMs));
      await this.deps.db.system((tx) =>
        tx.query(
          'update job_leases set leased_until = $1, last_run_at = $2 where name = $3 and holder = $4',
          [now, lastRun, j.name, this.holder],
        ),
      );
      rep.ran.push(entry);
    }
    return rep;
  }
}
