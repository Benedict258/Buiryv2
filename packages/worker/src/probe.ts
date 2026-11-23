import type { WalrusMemoryAdapter } from '@buiry/storage';
import { genId, raiseFlag, type ServiceDeps, type StorageRegistry } from '@buiry/api';

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
      // Projects with their own account are probed by ownRelayerProbe against their own relayer (Phase 10 F3).
      'select id, workspace_id from projects where archived_at is null and id not in (select project_id from project_storage)',
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

/** The notice a project sees while its own relayer is not taking writes (Phase 10 F3). Content-free: no URL or id. */
export const OWN_RELAYER_NOTICE = {
  degraded:
    "This project's Walrus relayer reports writes degraded. New memories stay queued and are retried after a few minutes; nothing is lost.",
  paused: "This project's Walrus relayer has paused writes. New memories stay queued until it resumes.",
  unreachable:
    "This project's Walrus relayer cannot be reached. New memories stay queued and reads come from cache.",
} as const;

/**
 * Probes each project's own relayer (bring your own; the only kind in preview) and raises or resolves a `relayer` flag
 * on that project alone. The flag shows in Alerts and in briefings. Each relayer is asked once per run, however many
 * projects use it. Never records a URL, account id or key.
 */
export async function ownRelayerProbe(
  deps: ServiceDeps,
  registry: StorageRegistry,
): Promise<Record<string, ProbeReport['state']>> {
  const rows = await deps.db.system(
    async (tx) =>
      (
        await tx.query<{ project_id: string; relayer_url: string; workspace_id: string }>(
          `select s.project_id, s.relayer_url, p.workspace_id from project_storage s join projects p on p.id = s.project_id
            where p.archived_at is null order by s.project_id`,
        )
      ).rows,
  );
  const byUrl = new Map<string, ProbeReport['state']>();
  const out: Record<string, ProbeReport['state']> = {};
  for (const r of rows) {
    let state = byUrl.get(r.relayer_url);
    if (!state) {
      const adapter = await registry.byoAdapter(deps, r.project_id).catch(() => undefined);
      const h = adapter
        ? await adapter.health().catch(() => ({ reachable: false, writeState: 'paused' as const }))
        : { reachable: false, writeState: 'paused' as const };
      state = !h.reachable ? 'unreachable' : h.writeState;
      byUrl.set(r.relayer_url, state);
    }
    out[r.project_id] = state;
    await deps.db.system(async (tx) => {
      if (state === 'ok')
        await tx.query(
          `update flags set state = 'resolved', resolved_at = $1 where project_id = $2 and kind = 'relayer' and state <> 'resolved'`,
          [new Date(deps.now()), r.project_id],
        );
      else
        await raiseFlag(deps, tx, {
          workspaceId: r.workspace_id,
          projectId: r.project_id,
          kind: 'relayer',
          severity: state === 'degraded' ? 'warning' : 'critical',
          detail: OWN_RELAYER_NOTICE[state],
        });
    });
  }
  return out;
}
