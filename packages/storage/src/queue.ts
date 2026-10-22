export type JobState = 'queued' | 'submitting' | 'submitted' | 'stored' | 'dead';

export interface WriteJob {
  id: string;
  memoryId: string;
  /** Unique: a repeat enqueue returns the original job (NFR-5). */
  idempotencyKey: string;
  namespace: string;
  projectId: string;
  agentId: string;
  text: string;
  /** Caller-defined reference (the memory event id) so completion can be mapped back. */
  ref: string | null;
  state: JobState;
  attempts: number;
  /** Next submit time (queued) or next poll time (submitted). */
  nextAttemptAt: number;
  leaseUntil: number | null;
  leasedBy: string | null;
  relayerJobId: string | null;
  blobId: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export type NewWriteJob = Pick<
  WriteJob,
  'id' | 'memoryId' | 'idempotencyKey' | 'namespace' | 'projectId' | 'agentId' | 'text'
> & {
  ref?: string;
  at: number;
};

export interface QueueStats {
  queued: number;
  submitting: number;
  submitted: number;
  stored: number;
  dead: number;
  /** Age of the oldest job that is not stored/dead. */
  oldestPendingAgeMs: number;
}

export interface Lease {
  /** Ready to submit, all in one namespace (bulk-able). */
  ready: WriteJob[];
  /** Were mid-submit when a previous worker's lease expired: the relayer may or may not have them. */
  uncertain: WriteJob[];
}

/** Durable, lease-based write queue. Implementations: InMemoryWriteQueue (tests), PgWriteQueue. */
export interface WriteQueue {
  enqueue(job: NewWriteJob): Promise<{ job: WriteJob; created: boolean }>;
  get(id: string): Promise<WriteJob | null>;
  findByKey(idempotencyKey: string): Promise<WriteJob | null>;
  leaseSubmittable(now: number, workerId: string, leaseMs: number, max: number): Promise<Lease>;
  leasePollable(now: number, workerId: string, leaseMs: number, max: number): Promise<WriteJob[]>;
  markSubmitted(id: string, relayerJobId: string, pollAt: number, now: number): Promise<void>;
  schedulePoll(id: string, pollAt: number, now: number): Promise<void>;
  markStored(id: string, blobId: string, now: number): Promise<void>;
  /** Back to `queued` with a delay (retryable failure). */
  scheduleRetry(id: string, error: string, nextAttemptAt: number, now: number): Promise<void>;
  markDead(id: string, error: string, now: number): Promise<void>;
  /** Dead-letter retry from the dashboard. */
  requeue(id: string, now: number): Promise<void>;
  countCreatedSince(since: number, filter: { agentId?: string; projectId?: string }): Promise<number>;
  stats(now: number): Promise<QueueStats>;
  listDead(limit: number): Promise<WriteJob[]>;
}

export class InMemoryWriteQueue implements WriteQueue {
  private readonly jobs = new Map<string, WriteJob>();
  private readonly byKey = new Map<string, string>();

  /** Simulates a process crash for tests: nothing is lost because state lives here. */
  snapshot(): WriteJob[] {
    return [...this.jobs.values()].map((j) => ({ ...j }));
  }

  async enqueue(n: NewWriteJob): Promise<{ job: WriteJob; created: boolean }> {
    const existingId = this.byKey.get(n.idempotencyKey);
    if (existingId) return { job: { ...this.jobs.get(existingId)! }, created: false };
    const job: WriteJob = {
      id: n.id,
      memoryId: n.memoryId,
      idempotencyKey: n.idempotencyKey,
      namespace: n.namespace,
      projectId: n.projectId,
      agentId: n.agentId,
      text: n.text,
      ref: n.ref ?? null,
      state: 'queued',
      attempts: 0,
      nextAttemptAt: n.at,
      leaseUntil: null,
      leasedBy: null,
      relayerJobId: null,
      blobId: null,
      lastError: null,
      createdAt: n.at,
      updatedAt: n.at,
    };
    this.jobs.set(job.id, job);
    this.byKey.set(job.idempotencyKey, job.id);
    return { job: { ...job }, created: true };
  }

  async get(id: string): Promise<WriteJob | null> {
    const j = this.jobs.get(id);
    return j ? { ...j } : null;
  }

  async findByKey(key: string): Promise<WriteJob | null> {
    const id = this.byKey.get(key);
    return id ? { ...this.jobs.get(id)! } : null;
  }

  private leased(j: WriteJob, now: number): boolean {
    return j.leaseUntil !== null && j.leaseUntil > now;
  }

  async leaseSubmittable(now: number, workerId: string, leaseMs: number, max: number): Promise<Lease> {
    const all = [...this.jobs.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const uncertain = all.filter((j) => j.state === 'submitting' && !this.leased(j, now));
    const ready = all.filter((j) => j.state === 'queued' && j.nextAttemptAt <= now && !this.leased(j, now));
    const ns = ready[0]?.namespace;
    const batch = ready.filter((j) => j.namespace === ns).slice(0, max);
    for (const j of batch) {
      j.state = 'submitting';
      j.attempts += 1;
      j.leasedBy = workerId;
      j.leaseUntil = now + leaseMs;
      j.updatedAt = now;
    }
    for (const j of uncertain) {
      j.leasedBy = workerId;
      j.leaseUntil = now + leaseMs;
      j.updatedAt = now;
    }
    return { ready: batch.map((j) => ({ ...j })), uncertain: uncertain.map((j) => ({ ...j })) };
  }

  async leasePollable(now: number, workerId: string, leaseMs: number, max: number): Promise<WriteJob[]> {
    const due = [...this.jobs.values()]
      .filter((j) => j.state === 'submitted' && j.nextAttemptAt <= now && !this.leased(j, now))
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
      .slice(0, max);
    for (const j of due) {
      j.leasedBy = workerId;
      j.leaseUntil = now + leaseMs;
      j.updatedAt = now;
    }
    return due.map((j) => ({ ...j }));
  }

  private must(id: string): WriteJob {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`unknown job ${id}`);
    return j;
  }

  private release(j: WriteJob, now: number): void {
    j.leaseUntil = null;
    j.leasedBy = null;
    j.updatedAt = now;
  }

  async markSubmitted(id: string, relayerJobId: string, pollAt: number, now: number): Promise<void> {
    const j = this.must(id);
    j.state = 'submitted';
    j.relayerJobId = relayerJobId;
    j.nextAttemptAt = pollAt;
    this.release(j, now);
  }

  async schedulePoll(id: string, pollAt: number, now: number): Promise<void> {
    const j = this.must(id);
    j.nextAttemptAt = pollAt;
    this.release(j, now);
  }

  async markStored(id: string, blobId: string, now: number): Promise<void> {
    const j = this.must(id);
    j.state = 'stored';
    j.blobId = blobId;
    j.lastError = null;
    this.release(j, now);
  }

  async scheduleRetry(id: string, error: string, nextAttemptAt: number, now: number): Promise<void> {
    const j = this.must(id);
    j.state = 'queued';
    j.relayerJobId = null;
    j.lastError = error;
    j.nextAttemptAt = nextAttemptAt;
    this.release(j, now);
  }

  async markDead(id: string, error: string, now: number): Promise<void> {
    const j = this.must(id);
    j.state = 'dead';
    j.lastError = error;
    this.release(j, now);
  }

  async requeue(id: string, now: number): Promise<void> {
    const j = this.must(id);
    if (j.state !== 'dead') return;
    j.state = 'queued';
    j.attempts = 0;
    j.nextAttemptAt = now;
    this.release(j, now);
  }

  async countCreatedSince(since: number, f: { agentId?: string; projectId?: string }): Promise<number> {
    let n = 0;
    for (const j of this.jobs.values()) {
      if (j.createdAt < since) continue;
      if (f.agentId && j.agentId !== f.agentId) continue;
      if (f.projectId && j.projectId !== f.projectId) continue;
      n++;
    }
    return n;
  }

  async stats(now: number): Promise<QueueStats> {
    const s: QueueStats = {
      queued: 0,
      submitting: 0,
      submitted: 0,
      stored: 0,
      dead: 0,
      oldestPendingAgeMs: 0,
    };
    for (const j of this.jobs.values()) {
      s[j.state] += 1;
      if (j.state !== 'stored' && j.state !== 'dead')
        s.oldestPendingAgeMs = Math.max(s.oldestPendingAgeMs, now - j.createdAt);
    }
    return s;
  }

  async listDead(limit: number): Promise<WriteJob[]> {
    return [...this.jobs.values()]
      .filter((j) => j.state === 'dead')
      .slice(0, limit)
      .map((j) => ({ ...j }));
  }
}
