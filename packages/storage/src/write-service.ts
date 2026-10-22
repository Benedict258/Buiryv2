import { idempotencyKey as computeKey, newId } from '@buiry/core';
import { checkAdmission, deriveBudgets, type AdmissionBudgets } from './budget.js';
import type { WriteQueue, JobState } from './queue.js';

export interface AcceptInput {
  memoryId: string;
  namespace: string;
  projectId: string;
  agentId: string;
  /** First line of the encoded memory (the machine header). */
  header: string;
  /** Full encoded text (header + body + evidence). */
  text: string;
}

export type AcceptResult =
  | { ok: true; jobId: string; state: JobState; duplicate: boolean }
  | { ok: false; code: 'budget_exceeded'; scope: string; retryAfterMs: number; message: string };

/** Accept-fast entry point used by the memory service (queued state returns immediately). */
export class WriteService {
  constructor(
    private readonly queue: WriteQueue,
    private readonly now: () => number,
    private readonly random: (n: number) => Uint8Array,
    private readonly budgets: AdmissionBudgets = deriveBudgets(),
  ) {}

  async accept(i: AcceptInput): Promise<AcceptResult> {
    const key = computeKey(i.namespace, i.header, i.text);
    const existing = await this.queue.findByKey(key);
    if (existing) return { ok: true, jobId: existing.id, state: existing.state, duplicate: true };
    const at = this.now();
    const adm = await checkAdmission(
      this.queue,
      this.budgets,
      { agentId: i.agentId, projectId: i.projectId },
      at,
    );
    if (!adm.ok)
      return {
        ok: false,
        code: 'budget_exceeded',
        scope: adm.scope,
        retryAfterMs: adm.retryAfterMs,
        message: adm.message,
      };
    const { job, created } = await this.queue.enqueue({
      id: newId('job', at, this.random),
      memoryId: i.memoryId,
      idempotencyKey: key,
      namespace: i.namespace,
      projectId: i.projectId,
      agentId: i.agentId,
      text: i.text,
      at,
    });
    return { ok: true, jobId: job.id, state: job.state, duplicate: !created };
  }
}
