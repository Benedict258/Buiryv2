import type { WalrusMemoryAdapter } from '@buiry/storage';
import { genId, raiseFlag, type ServiceDeps } from '@buiry/api';

export interface ProbeReport {
  state: 'ok' | 'degraded' | 'paused' | 'unreachable';
  version?: string;
}

/** Records relayer health and raises/resolves a flag on every project while writes are not `ok`. */
export async function relayerProbe(
  deps: ServiceDeps,
  adapter: WalrusMemoryAdapter,
  url = '',
): Promise<ProbeReport> {
  const h = await adapter
    .health()
    .catch(() => ({ reachable: false, writeState: 'paused' as const, version: undefined }));
  const state: ProbeReport['state'] = !h.reachable ? 'unreachable' : h.writeState;
  await deps.db.system(async (tx) => {
    await tx.query(
      'insert into relayer_status (id, relayer_url, reachable, write_state, version, checked_at) values ($1,$2,$3,$4,$5,$6)',
      [genId(deps, 'evt'), url, h.reachable, h.writeState, h.version ?? null, new Date(deps.now())],
    );
    await tx.query(
      `delete from relayer_status where id in (select id from relayer_status order by checked_at desc offset 200)`,
    );
    const projects = await tx.query<{ id: string; workspace_id: string }>(
      'select id, workspace_id from projects where archived_at is null',
    );
    for (const pr of projects.rows) {
      if (state === 'ok') {
        await tx.query(
          `update flags set state = 'resolved', resolved_at = $1 where project_id = $2 and kind = 'relayer' and state <> 'resolved'`,
          [new Date(deps.now()), pr.id],
        );
      } else {
        await raiseFlag(deps, tx, {
          workspaceId: pr.workspace_id,
          projectId: pr.id,
          kind: 'relayer',
          severity: state === 'degraded' ? 'warning' : 'critical',
          detail: `Storage relayer is ${state}. New memories are queued and reads come from cache.`,
        });
      }
    }
  });
  return { state, ...(h.version ? { version: h.version } : {}) };
}
