import type { ServiceDeps } from '@buiry/api';

export interface ScheduledJob {
  name: string;
  intervalMs: number;
  run: () => Promise<unknown>;
}

export interface SchedulerTickReport {
  ran: { name: string; ok: boolean; error?: string; result?: unknown }[];
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
      try {
        entry = { name: j.name, ok: true, result: await j.run() };
      } catch (e) {
        entry = { name: j.name, ok: false, error: (e as Error).message };
      }
      const now = new Date(this.deps.now());
      // A failed run is retried on the next tick rather than waiting a full interval.
      await this.deps.db.system((tx) =>
        tx.query(
          'update job_leases set leased_until = $1, last_run_at = $2 where name = $3 and holder = $4',
          [now, entry.ok ? now : null, j.name, this.holder],
        ),
      );
      rep.ran.push(entry);
    }
    return rep;
  }
}
