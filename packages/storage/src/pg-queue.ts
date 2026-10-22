import type { JobState, Lease, NewWriteJob, QueueStats, WriteJob, WriteQueue } from './queue.js';

/** Minimal client surface so `pg` and PGlite both fit. */
export interface SqlClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export const WRITE_JOBS_DDL = `
create table if not exists write_jobs (
  id text primary key,
  memory_id text not null,
  idempotency_key text not null unique,
  namespace text not null,
  project_id text not null,
  agent_id text not null,
  text text not null,
  ref text,
  state text not null check (state in ('queued','submitting','submitted','stored','dead')),
  attempts int not null default 0,
  next_attempt_at bigint not null,
  lease_until bigint,
  leased_by text,
  relayer_job_id text,
  blob_id text,
  last_error text,
  created_at bigint not null,
  updated_at bigint not null
);
create index if not exists write_jobs_ready_idx on write_jobs (state, next_attempt_at);
create index if not exists write_jobs_created_idx on write_jobs (created_at);
create index if not exists write_jobs_project_idx on write_jobs (project_id, created_at);
`;

interface Row {
  id: string;
  memory_id: string;
  idempotency_key: string;
  namespace: string;
  project_id: string;
  agent_id: string;
  text: string;
  ref: string | null;
  state: JobState;
  attempts: number;
  next_attempt_at: string | number;
  lease_until: string | number | null;
  leased_by: string | null;
  relayer_job_id: string | null;
  blob_id: string | null;
  last_error: string | null;
  created_at: string | number;
  updated_at: string | number;
}

const toJob = (r: Row): WriteJob => ({
  id: r.id,
  memoryId: r.memory_id,
  idempotencyKey: r.idempotency_key,
  namespace: r.namespace,
  projectId: r.project_id,
  agentId: r.agent_id,
  text: r.text,
  ref: r.ref,
  state: r.state,
  attempts: Number(r.attempts),
  nextAttemptAt: Number(r.next_attempt_at),
  leaseUntil: r.lease_until === null ? null : Number(r.lease_until),
  leasedBy: r.leased_by,
  relayerJobId: r.relayer_job_id,
  blobId: r.blob_id,
  lastError: r.last_error,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

export class PgWriteQueue implements WriteQueue {
  constructor(private readonly db: SqlClient) {}

  async enqueue(n: NewWriteJob): Promise<{ job: WriteJob; created: boolean }> {
    const ins = await this.db.query<Row>(
      `insert into write_jobs (id, memory_id, idempotency_key, namespace, project_id, agent_id, text, ref, state, attempts, next_attempt_at, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$9,'queued',0,$8,$8,$8)
       on conflict (idempotency_key) do nothing returning *`,
      [n.id, n.memoryId, n.idempotencyKey, n.namespace, n.projectId, n.agentId, n.text, n.at, n.ref ?? null],
    );
    if (ins.rows[0]) return { job: toJob(ins.rows[0]), created: true };
    const ex = await this.db.query<Row>('select * from write_jobs where idempotency_key = $1', [
      n.idempotencyKey,
    ]);
    return { job: toJob(ex.rows[0]!), created: false };
  }

  async get(id: string): Promise<WriteJob | null> {
    const r = await this.db.query<Row>('select * from write_jobs where id = $1', [id]);
    return r.rows[0] ? toJob(r.rows[0]) : null;
  }

  async findByKey(key: string): Promise<WriteJob | null> {
    const r = await this.db.query<Row>('select * from write_jobs where idempotency_key = $1', [key]);
    return r.rows[0] ? toJob(r.rows[0]) : null;
  }

  async leaseSubmittable(now: number, workerId: string, leaseMs: number, max: number): Promise<Lease> {
    const unc = await this.db.query<Row>(
      `update write_jobs set leased_by = $1, lease_until = $2, updated_at = $3
       where state = 'submitting' and (lease_until is null or lease_until <= $3) returning *`,
      [workerId, now + leaseMs, now],
    );
    const ready = await this.db.query<Row>(
      `update write_jobs set state = 'submitting', attempts = attempts + 1, leased_by = $1, lease_until = $2, updated_at = $3
       where id in (
         select id from write_jobs
         where state = 'queued' and next_attempt_at <= $3 and (lease_until is null or lease_until <= $3)
           and namespace = (select namespace from write_jobs where state = 'queued' and next_attempt_at <= $3 and (lease_until is null or lease_until <= $3)
                            order by created_at, id limit 1)
         order by created_at, id limit $4
         for update skip locked)
       returning *`,
      [workerId, now + leaseMs, now, max],
    );
    const byCreated = (a: WriteJob, b: WriteJob) => a.createdAt - b.createdAt || a.id.localeCompare(b.id);
    return { ready: ready.rows.map(toJob).sort(byCreated), uncertain: unc.rows.map(toJob).sort(byCreated) };
  }

  async leasePollable(now: number, workerId: string, leaseMs: number, max: number): Promise<WriteJob[]> {
    const r = await this.db.query<Row>(
      `update write_jobs set leased_by = $1, lease_until = $2, updated_at = $3
       where id in (select id from write_jobs where state = 'submitted' and next_attempt_at <= $3 and (lease_until is null or lease_until <= $3)
                    order by next_attempt_at limit $4 for update skip locked)
       returning *`,
      [workerId, now + leaseMs, now, max],
    );
    return r.rows.map(toJob);
  }

  private async set(id: string, now: number, sets: string, params: unknown[]): Promise<void> {
    await this.db.query(
      `update write_jobs set ${sets}, lease_until = null, leased_by = null, updated_at = $1 where id = $2`,
      [now, id, ...params],
    );
  }

  markSubmitted(id: string, relayerJobId: string, pollAt: number, now: number): Promise<void> {
    return this.set(id, now, `state = 'submitted', relayer_job_id = $3, next_attempt_at = $4`, [
      relayerJobId,
      pollAt,
    ]);
  }
  schedulePoll(id: string, pollAt: number, now: number): Promise<void> {
    return this.set(id, now, 'next_attempt_at = $3', [pollAt]);
  }
  markStored(id: string, blobId: string, now: number): Promise<void> {
    return this.set(id, now, `state = 'stored', blob_id = $3, last_error = null`, [blobId]);
  }
  scheduleRetry(id: string, error: string, nextAttemptAt: number, now: number): Promise<void> {
    return this.set(
      id,
      now,
      `state = 'queued', relayer_job_id = null, last_error = $3, next_attempt_at = $4`,
      [error, nextAttemptAt],
    );
  }
  markDead(id: string, error: string, now: number): Promise<void> {
    return this.set(id, now, `state = 'dead', last_error = $3`, [error]);
  }
  async requeue(id: string, now: number): Promise<void> {
    await this.db.query(
      `update write_jobs set state = 'queued', attempts = 0, next_attempt_at = $1, lease_until = null, leased_by = null, updated_at = $1
       where id = $2 and state = 'dead'`,
      [now, id],
    );
  }

  async countCreatedSince(since: number, f: { agentId?: string; projectId?: string }): Promise<number> {
    const r = await this.db.query<{ n: string | number }>(
      `select count(*) as n from write_jobs where created_at >= $1 and ($2::text is null or agent_id = $2) and ($3::text is null or project_id = $3)`,
      [since, f.agentId ?? null, f.projectId ?? null],
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  async stats(now: number): Promise<QueueStats> {
    const r = await this.db.query<{ state: JobState; n: string | number; oldest: string | number | null }>(
      `select state, count(*) as n, min(created_at) as oldest from write_jobs group by state`,
    );
    const s: QueueStats = {
      queued: 0,
      submitting: 0,
      submitted: 0,
      stored: 0,
      dead: 0,
      oldestPendingAgeMs: 0,
    };
    for (const row of r.rows) {
      s[row.state] = Number(row.n);
      if (
        (row.state === 'queued' || row.state === 'submitting' || row.state === 'submitted') &&
        row.oldest !== null
      ) {
        s.oldestPendingAgeMs = Math.max(s.oldestPendingAgeMs, now - Number(row.oldest));
      }
    }
    return s;
  }

  async listDead(limit: number): Promise<WriteJob[]> {
    const r = await this.db.query<Row>(
      `select * from write_jobs where state = 'dead' order by created_at limit $1`,
      [limit],
    );
    return r.rows.map(toJob);
  }
}
