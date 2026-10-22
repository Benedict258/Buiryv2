import {
  reconcileExpiry,
  type ExpiryStore,
  type Renewer,
  type StoredRef,
  type WalrusMemoryAdapter,
} from '@buiry/storage';
import { raiseFlag, type ServiceDeps } from '@buiry/api';

class PgExpiryStore implements ExpiryStore {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly projectId: string,
  ) {}

  listStoredMemories(): Promise<StoredRef[]> {
    return this.deps.db.system(async (tx) => {
      const r = await tx.query<{ id: string; walrus_blob_id: string; namespace: string }>(
        `select m.id, m.walrus_blob_id, b.namespace from memories m join branches b on b.id = m.branch_id
          where m.project_id = $1 and m.write_state = 'stored' and m.expired = false and m.walrus_blob_id is not null`,
        [this.projectId],
      );
      return r.rows.map((x) => ({ memoryId: x.id, blobId: x.walrus_blob_id, namespace: x.namespace }));
    });
  }

  setExpiry(memoryId: string, e: { endEpoch?: number; expiresAt?: number }): Promise<void> {
    return this.deps.db.system(async (tx) => {
      await tx.query(
        'update memories set end_epoch = coalesce($1, end_epoch), expires_at = coalesce($2, expires_at) where id = $3',
        [e.endEpoch ?? null, e.expiresAt !== undefined ? new Date(e.expiresAt) : null, memoryId],
      );
    });
  }

  markExpired(memoryId: string): Promise<void> {
    return this.deps.db.system(async (tx) => {
      await tx.query('update memories set expired = true where id = $1', [memoryId]);
    });
  }
}

export interface ExpiryJobOptions {
  adapter: WalrusMemoryAdapter;
  checkIntervalMs: number;
  renewalEnabled?: boolean;
  renewer?: Renewer;
}

export interface ExpiryJobReport {
  projects: number;
  expiring: number;
  expired: number;
  missing: number;
  renewed: number;
}

/** Reads end epoch / expiry from the read interface, flags what is expiring or lost, resolves flags for renewed memories. */
export async function expiryScan(deps: ServiceDeps, o: ExpiryJobOptions): Promise<ExpiryJobReport> {
  const projects = await deps.db.system((tx) =>
    tx.query<{ id: string; workspace_id: string }>(
      'select id, workspace_id from projects where archived_at is null',
    ),
  );
  const total: ExpiryJobReport = {
    projects: projects.rows.length,
    expiring: 0,
    expired: 0,
    missing: 0,
    renewed: 0,
  };
  for (const pr of projects.rows) {
    const rep = await reconcileExpiry({
      adapter: o.adapter,
      store: new PgExpiryStore(deps, pr.id),
      now: deps.now(),
      checkIntervalMs: o.checkIntervalMs,
      ...(o.renewalEnabled ? { renewalEnabled: true } : {}),
      ...(o.renewer ? { renewer: o.renewer } : {}),
    }).catch(() => null);
    if (!rep) continue;
    total.expiring += rep.expiring.length;
    total.expired += rep.expired.length + rep.deleted.length;
    total.missing += rep.missing.length;
    total.renewed += rep.renewed.length;
    await deps.db.tenant(pr.workspace_id, async (tx) => {
      for (const e of rep.expiring) {
        await raiseFlag(deps, tx, {
          workspaceId: pr.workspace_id,
          projectId: pr.id,
          memoryId: e.memoryId,
          kind: 'expiring',
          severity: 'warning',
          detail: `Stored memory expires ${new Date(e.expiresAt).toISOString().slice(0, 10)}; export or renew before then`,
        });
      }
      for (const id of [...rep.expired, ...rep.deleted]) {
        await raiseFlag(deps, tx, {
          workspaceId: pr.workspace_id,
          projectId: pr.id,
          memoryId: id,
          kind: 'expiring',
          severity: 'critical',
          detail: 'This memory has expired from storage and is no longer recalled',
        });
      }
      const still = rep.expiring.map((e) => e.memoryId);
      await tx.query(
        `update flags set state = 'resolved', resolved_at = $1 where project_id = $2 and kind = 'expiring' and state <> 'resolved' and memory_id is not null and severity = 'warning' and not (memory_id = any($3))`,
        [new Date(deps.now()), pr.id, still],
      );
    });
  }
  return total;
}
