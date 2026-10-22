import { createHash } from 'node:crypto';
import { BuiryError, renderSnapshot } from '@buiry/core';
import { MemoryService, emitDurableForSystem, systemPrincipal, type ServiceDeps } from '@buiry/api';

export interface SnapshotReport {
  projectsChanged: number;
  snapshotEvents: number;
}

/**
 * Regenerates each project's BUIRY.md snapshot region when material state changed (stored on the project
 * for `buiry sync` and the dashboard), and writes `memory.snapshot` events for memories whose derived
 * confidence moved enough that a rebuild would otherwise lose it.
 */
export async function snapshotRegen(
  deps: ServiceDeps,
  o: { maxEventsPerProject?: number; minDelta?: number } = {},
): Promise<SnapshotReport> {
  const out: SnapshotReport = { projectsChanged: 0, snapshotEvents: 0 };
  const projects = await deps.db.system((tx) =>
    tx.query<{ id: string; workspace_id: string; settings: { snapshot?: { hash?: string } } }>(
      'select id, workspace_id, settings from projects where archived_at is null',
    ),
  );
  const svc = new MemoryService(deps);
  for (const pr of projects.rows) {
    const p = systemPrincipal(pr.workspace_id);
    const b = await svc.briefingPreview(p, pr.id, { branch: 'main', tokenBudget: 1200, task: '' });
    const hash = createHash('sha256').update(b.briefing).digest('hex');
    if (pr.settings.snapshot?.hash !== hash) {
      const text = renderSnapshot({
        generatedAt: new Date(deps.now()).toISOString().slice(0, 16) + 'Z',
        briefingMarkdown: b.briefing,
      });
      await deps.db.system((tx) =>
        tx.query(
          `update projects set settings = jsonb_set(settings, '{snapshot}', $1::jsonb) where id = $2`,
          [JSON.stringify({ hash, text, generatedAt: new Date(deps.now()).toISOString() }), pr.id],
        ),
      );
      out.projectsChanged++;
    }
    const minDelta = o.minDelta ?? 0.1;
    const rows = await deps.db.system((tx) =>
      tx.query<{
        id: string;
        confidence: number;
        snapshot_confidence: number | null;
        branch_slug: string;
        wrongs: number;
        helped: string | number;
        wrong: string | number;
      }>(
        `select m.id, m.confidence, m.snapshot_confidence, m.branch_slug, 0 as wrongs,
                (select count(*) from memory_events e where e.memory_id = m.id and e.type = 'memory.reported' and e.payload->>'outcome' = 'helped') as helped,
                (select count(*) from memory_events e where e.memory_id = m.id and e.type = 'memory.reported' and e.payload->>'outcome' in ('wrong','outdated')) as wrong
           from memories m where m.project_id = $1 and m.write_state = 'stored' and m.status not in ('superseded','tombstoned') and m.expired = false
            and abs(m.confidence - coalesce(m.snapshot_confidence, $4::real)) >= $2
          limit $3`,
        [pr.id, minDelta, o.maxEventsPerProject ?? 20, deps.learning?.initialAgent ?? 0.35],
      ),
    );
    for (const m of rows.rows) {
      try {
        await emitDurableForSystem(deps, pr.workspace_id, pr.id, m.id, m.branch_slug, {
          evt: 'memory.snapshot',
          body: `Snapshot of derived state: confidence ${Number(m.confidence).toFixed(2)}, helpful reports ${Number(m.helped)}, wrong reports ${Number(m.wrong)}.`,
          conf: Number(m.confidence).toFixed(2),
          sig: `helped:${Number(m.helped)},wrong:${Number(m.wrong)}`,
        });
        await deps.db.system((tx) =>
          tx.query('update memories set snapshot_at = $1, snapshot_confidence = $2 where id = $3', [
            new Date(deps.now()),
            m.confidence,
            m.id,
          ]),
        );
        out.snapshotEvents++;
      } catch (e) {
        if (!(e instanceof BuiryError && e.code === 'budget_exceeded')) throw e; // snapshots are best effort
      }
    }
  }
  return out;
}
