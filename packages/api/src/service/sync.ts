import {
  PgWriteQueue,
  WriteWorker,
  type WalrusMemoryAdapter,
  type WorkerOptions,
  type WriteJob,
  type WriteQueue,
} from '@buiry/storage';
import type { ServiceDeps } from './types.js';
import { genId } from './util.js';

/** A queue whose every call runs in its own system transaction (workers have no tenant context). */
export function systemQueue(deps: ServiceDeps): WriteQueue {
  return new PgWriteQueue({ query: (q, p) => deps.db.system((tx) => tx.query(q, p)) });
}

/** Maps a completed Walrus write back onto the memory and its event. */
export async function onJobStored(deps: ServiceDeps, job: WriteJob, blobId: string): Promise<void> {
  if (!job.ref) return;
  await deps.db.system(async (tx) => {
    const ev = await tx.query<{ memory_id: string; type: string }>(
      'update memory_events set walrus_blob_id = $1 where id = $2 returning memory_id, type',
      [blobId, job.ref],
    );
    const e = ev.rows[0];
    if (e && (e.type === 'memory.created' || e.type === 'handoff.created')) {
      await tx.query(
        `update memories set walrus_blob_id = $1, walrus_job_id = $2, write_state = 'stored' where id = $3`,
        [blobId, job.relayerJobId, e.memory_id],
      );
    }
  });
}

/** A write that exhausted its retries: mark the memory failed and raise a flag. */
export async function onJobDead(deps: ServiceDeps, job: WriteJob, error: string): Promise<void> {
  if (!job.ref) return;
  await deps.db.system(async (tx) => {
    const ev = await tx.query<{ memory_id: string; type: string; workspace_id: string }>(
      'select memory_id, type, workspace_id from memory_events where id = $1',
      [job.ref],
    );
    const e = ev.rows[0];
    if (!e) return;
    if (e.type === 'memory.created' || e.type === 'handoff.created') {
      await tx.query(`update memories set write_state = 'failed' where id = $1`, [e.memory_id]);
    }
    await tx.query(
      `insert into flags (id, workspace_id, project_id, memory_id, kind, severity, detail, group_key, first_seen, last_seen)
       values ($1,$2,$3,$4,'failed_write','critical',$5,$6,$7,$7)`,
      [
        genId(deps, 'flg'),
        e.workspace_id,
        job.projectId,
        e.memory_id,
        `Write failed after retries: ${error.slice(0, 200)}`,
        `failed_write:${e.memory_id}`,
        new Date(deps.now()),
      ],
    );
  });
}

export function createDrain(
  deps: ServiceDeps,
  adapter: WalrusMemoryAdapter,
  o: Partial<WorkerOptions> & { workerId?: string } = {},
): WriteWorker {
  return new WriteWorker({
    queue: systemQueue(deps),
    adapter,
    workerId: o.workerId ?? 'worker-1',
    now: deps.now,
    onStored: (j, b) => onJobStored(deps, j, b),
    onDead: (j, e) => onJobDead(deps, j, e),
    ...o,
  });
}
