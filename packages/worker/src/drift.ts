import { MemoryService, systemPrincipal, verifyOp, type ServiceDeps } from '@buiry/api';

export interface DriftOptions {
  perProject?: number;
  /** Do not start new checks once the gateway reports degraded. */
  stopWhenDegraded?: boolean;
}

export interface DriftReport {
  checked: number;
  stale: number;
  degraded: number;
  skippedReason?: string;
}

/**
 * Re-verifies chain evidence on a priority basis: memories that agents actually recall come first,
 * then those least recently verified. The gateway's own cache, rate limit and per-workspace credit
 * budget bound the cost; an outage yields unknown results and never marks anything stale.
 */
export async function driftScan(deps: ServiceDeps, o: DriftOptions = {}): Promise<DriftReport> {
  const rep: DriftReport = { checked: 0, stale: 0, degraded: 0 };
  if (!deps.gateway) return { ...rep, skippedReason: 'chain gateway not configured' };
  const projects = await deps.db.system((tx) =>
    tx.query<{ id: string; workspace_id: string; settings: { driftScanIntervalHours?: number } }>(
      'select id, workspace_id, settings from projects where archived_at is null',
    ),
  );
  for (const pr of projects.rows) {
    if ((o.stopWhenDegraded ?? true) && deps.gateway.status().state === 'degraded')
      return { ...rep, skippedReason: 'gateway degraded' };
    const intervalMs = (pr.settings.driftScanIntervalHours ?? 6) * 3_600_000;
    const picks = await deps.db.system(async (tx) => {
      const r = await tx.query<{ id: string }>(
        `select m.id from memories m
          where m.project_id = $1 and m.status in ('proposed','confirmed','contested') and m.expired = false
            and exists (select 1 from evidence e where e.memory_id = m.id and e.kind in ('tx','object','package')
                          and (e.last_verified_at is null or e.last_verified_at < $2))
          order by (select count(*) from memory_events ev where ev.memory_id = m.id and ev.type = 'memory.recalled' and ev.created_at > $3) desc,
                   (select min(coalesce(e.last_verified_at, 'epoch'::timestamptz)) from evidence e where e.memory_id = m.id) asc
          limit $4`,
        [pr.id, new Date(deps.now() - intervalMs), new Date(deps.now() - 7 * 86_400_000), o.perProject ?? 10],
      );
      return r.rows;
    });
    const svc = new MemoryService(deps);
    void svc;
    const p = systemPrincipal(pr.workspace_id);
    for (const m of picks) {
      const out = await verifyOp(deps, p, pr.id, { memoryId: m.id }, { auto: true }).catch(() => null);
      if (!out) continue;
      rep.checked++;
      if (out.status === 'stale') rep.stale++;
      if (out.results.some((r) => r.degraded)) rep.degraded++;
    }
  }
  return rep;
}
