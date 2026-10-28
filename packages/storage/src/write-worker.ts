import { createHash } from 'node:crypto';
import { RelayerError, MAX_BULK, type WalrusMemoryAdapter, type WriteState } from './adapter.js';
import { PointsLimiter, PUBLIC_RELAYER_LIMITS, writePoints, type RelayerLimits } from './budget.js';
import type { WriteJob, WriteQueue } from './queue.js';

export interface WorkerOptions {
  queue: WriteQueue;
  adapter: WalrusMemoryAdapter;
  workerId: string;
  now: () => number;
  /** Uniform [0,1); injected for deterministic tests. */
  random?: () => number;
  limits?: RelayerLimits;
  limiter?: PointsLimiter;
  leaseMs?: number;
  pollIntervalMs?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /** Max items per tick while the relayer reports `degraded`. */
  degradedBatch?: number;
  onStored?: (job: WriteJob, blobId: string) => void | Promise<void>;
  onDead?: (job: WriteJob, error: string) => void | Promise<void>;
}

export interface TickReport {
  relayer: WriteState | 'unreachable';
  submitted: number;
  stored: number;
  retried: number;
  dead: number;
  reconciled: number;
  skipped?: 'paused' | 'unreachable' | 'budget';
}

/** Full-jitter exponential backoff. */
export function backoffMs(attempt: number, base: number, cap: number, rand: number): number {
  const ceil = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.floor(ceil / 2 + (ceil / 2) * rand);
}

export class WriteWorker {
  private readonly limiter: PointsLimiter;
  private readonly limits: RelayerLimits;
  private readonly o: Required<
    Pick<
      WorkerOptions,
      'leaseMs' | 'pollIntervalMs' | 'maxAttempts' | 'backoffBaseMs' | 'backoffCapMs' | 'degradedBatch'
    >
  >;
  lastRelayerState: WriteState | 'unreachable' = 'ok';

  constructor(private readonly w: WorkerOptions) {
    this.limits = w.limits ?? PUBLIC_RELAYER_LIMITS;
    this.limiter = w.limiter ?? new PointsLimiter(this.limits);
    this.o = {
      leaseMs: w.leaseMs ?? 60_000,
      pollIntervalMs: w.pollIntervalMs ?? 2_000,
      maxAttempts: w.maxAttempts ?? 6,
      backoffBaseMs: w.backoffBaseMs ?? 2_000,
      backoffCapMs: w.backoffCapMs ?? 5 * 60_000,
      degradedBatch: w.degradedBatch ?? 2,
    };
  }

  private rand(): number {
    return (this.w.random ?? Math.random)();
  }

  private async fail(job: WriteJob, e: unknown, report: TickReport): Promise<void> {
    const err = e instanceof RelayerError ? e : new RelayerError('unknown', (e as Error).message);
    const now = this.w.now();
    if (!err.retryable) return this.dead(job, `${err.kind}: ${err.message}`, report);
    if (job.attempts >= this.o.maxAttempts)
      return this.dead(job, `retries exhausted (${err.kind}): ${err.message}`, report);
    const wait = Math.max(
      err.retryAfterMs ?? 0,
      backoffMs(job.attempts, this.o.backoffBaseMs, this.o.backoffCapMs, this.rand()),
    );
    await this.w.queue.scheduleRetry(job.id, `${err.kind}: ${err.message}`, now + wait, now);
    report.retried++;
  }

  private async dead(job: WriteJob, error: string, report: TickReport): Promise<void> {
    await this.w.queue.markDead(job.id, error, this.w.now());
    report.dead++;
    await this.w.onDead?.(job, error);
  }

  private async stored(job: WriteJob, blobId: string, report: TickReport): Promise<void> {
    await this.w.queue.markStored(job.id, blobId, this.w.now());
    report.stored++;
    await this.w.onStored?.(job, blobId);
  }

  /** One drain cycle: poll submitted jobs, reconcile uncertain ones, submit new ones. */
  async tick(): Promise<TickReport> {
    const report: TickReport = { relayer: 'ok', submitted: 0, stored: 0, retried: 0, dead: 0, reconciled: 0 };
    const health = await this.w.adapter
      .health()
      .catch(() => ({ reachable: false, writeState: 'paused' as WriteState }));
    this.lastRelayerState = health.reachable ? health.writeState : 'unreachable';
    report.relayer = this.lastRelayerState;
    if (!health.reachable) {
      report.skipped = 'unreachable';
      return report;
    }

    await this.pollPhase(report);

    if (health.writeState === 'paused') {
      report.skipped = 'paused';
      return report;
    }
    await this.submitPhase(report, health.writeState === 'degraded');
    return report;
  }

  private async pollPhase(report: TickReport): Promise<void> {
    const jobs = await this.w.queue.leasePollable(this.w.now(), this.w.workerId, this.o.leaseMs, 50);
    for (const job of jobs) {
      try {
        const st = await this.w.adapter.getJob(job.relayerJobId!);
        const now = this.w.now();
        if (st.state === 'done') await this.stored(job, st.blobId, report);
        else if (st.state === 'failed') {
          if (st.retryable) await this.fail(job, new RelayerError('unavailable', st.error), report);
          else await this.dead(job, `job failed: ${st.error}`, report);
        } else await this.w.queue.schedulePoll(job.id, now + this.o.pollIntervalMs, now);
      } catch (e) {
        if (e instanceof RelayerError && e.kind === 'not_found') {
          // The relayer lost the job: resubmit through the normal retry path.
          await this.fail(job, new RelayerError('unavailable', 'relayer job vanished'), report);
        } else if (e instanceof RelayerError && !e.retryable) {
          await this.dead(job, `${e.kind}: ${e.message}`, report);
        } else {
          const now = this.w.now();
          await this.w.queue.schedulePoll(job.id, now + this.o.pollIntervalMs * 2, now);
        }
      }
    }
  }

  private async reconcile(job: WriteJob, report: TickReport): Promise<void> {
    // A crash happened between "submitting" and recording the relayer job id. The relayer has no
    // dedupe, so look for an identical stored text before resubmitting (best effort: recall can lag).
    try {
      const first = job.text.split('\n', 1)[0] ?? job.text;
      const r = await this.w.adapter.recall({ namespace: job.namespace, query: first, limit: 20 });
      const hit = r.results.find((x) => x.text === job.text);
      if (hit) {
        await this.stored(job, hit.blobId, report);
        report.reconciled++;
        return;
      }
    } catch {
      return; // leave the lease to expire; try again next cycle
    }
    const now = this.w.now();
    await this.w.queue.scheduleRetry(job.id, 'reconciled after crash: not found on relayer', now, now);
  }

  private async submitPhase(report: TickReport, degraded: boolean): Promise<void> {
    const now = this.w.now();
    const avail = this.limiter.available(now);
    let maxItems = Math.min(MAX_BULK, Math.floor(avail / this.limits.bulkPointsPerItem));
    if (degraded) maxItems = Math.min(maxItems, this.o.degradedBatch);
    const lease = await this.w.queue.leaseSubmittable(
      now,
      this.w.workerId,
      this.o.leaseMs,
      Math.max(maxItems, 0),
    );
    for (const j of lease.uncertain) await this.reconcile(j, report);
    const batch = lease.ready;
    if (batch.length === 0) {
      if (maxItems === 0) report.skipped = 'budget';
      return;
    }
    const take = this.limiter.tryTake(writePoints(this.limits, batch.length), this.w.now());
    if (!take.ok) {
      for (const j of batch)
        await this.w.queue.scheduleRetry(
          j.id,
          'local budget',
          this.w.now() + take.retryAfterMs,
          this.w.now(),
        );
      report.skipped = 'budget';
      return;
    }
    const pollAt = this.w.now() + this.o.pollIntervalMs;
    let jobIds: string[];
    try {
      if (batch.length === 1) {
        jobIds = [
          (
            await this.w.adapter.remember(batch[0]!.namespace, batch[0]!.text, {
              idempotencyKey: relayerKey(batch[0]!),
            })
          ).jobId,
        ];
      } else {
        jobIds = (
          await this.w.adapter.rememberBulk(
            batch[0]!.namespace,
            batch.map((j) => j.text),
            { idempotencyKey: bulkKey(batch) },
          )
        ).jobIds;
      }
    } catch (e) {
      for (const j of batch) await this.fail(j, e, report);
      return;
    }
    for (const [i, j] of batch.entries())
      await this.w.queue.markSubmitted(j.id, jobIds[i]!, pollAt, this.w.now());
    report.submitted += batch.length;
  }
}

/**
 * Key sent to the relayer, which collapses a repeated key onto the existing job. The first attempt uses the
 * plain key so a lost acceptance is deduplicated; later attempts get a suffix so a retry after a FAILED relayer
 * job is a new job instead of returning the failed one.
 */
function relayerKey(j: WriteJob): string {
  return j.attempts === 0 ? j.idempotencyKey : `${j.idempotencyKey}.a${j.attempts}`;
}

/** One relayer key for a bulk submit, derived from the ordered per-item keys so a retry of the same batch collapses. */
function bulkKey(batch: WriteJob[]): string {
  return 'bulk-' + createHash('sha256').update(batch.map(relayerKey).join('\n')).digest('hex');
}
