import { BuiryError } from '@buiry/core';
import type { Db } from '../db/db.js';
import type { ServiceDeps } from './types.js';
import { loadMemories, type MemoryRow } from './util.js';

export interface ShowcaseSettings {
  enabled?: boolean;
  show?: string[];
}

export interface Showcase {
  untrustedData: true;
  project: { id: string; name: string; networks: string[] };
  shows: string[];
  generatedAt: string;
  counts?: { total: number; byType: Record<string, number>; byStatus: Record<string, number> };
  memories?: {
    id: string;
    type: string;
    text: string;
    confidence: number;
    branch: string;
    createdAt: string;
    evidence?: { kind: string; label: string; result: string }[];
    blobId?: string | null;
    expiresAt?: string | null;
  }[];
  storage?: { storedMemories: number; soonestExpiry: string | null; mode: string };
}

const notShared = () => new BuiryError('not_found', 'this project is not shared');
const MAX_MEMORIES = 50;

/**
 * What a project owner chose to make public. Only projects with `publicShowcase.enabled` answer; everything
 * else is `not_found`, so existence is not revealed. Only confirmed memories are ever listed, and only the
 * sections the owner ticked. Agent identities, activity and tokens are never included.
 */
export async function showcaseFor(deps: ServiceDeps, db: Db, projectId: string): Promise<Showcase> {
  return db.system(async (tx) => {
    const pr = await tx.query<{
      id: string;
      name: string;
      networks: string[];
      settings: Record<string, unknown>;
      walrus_mode: string;
    }>(
      'select id, name, networks, settings, walrus_mode from projects where id = $1 and archived_at is null',
      [projectId],
    );
    const project = pr.rows[0];
    const cfg = (project?.settings.publicShowcase ?? {}) as ShowcaseSettings;
    if (!project || cfg.enabled !== true) throw notShared();
    const show = (cfg.show ?? ['counts']).filter((s) =>
      ['counts', 'memories', 'evidence', 'storage'].includes(s),
    );
    const out: Showcase = {
      untrustedData: true,
      project: { id: project.id, name: project.name, networks: project.networks },
      shows: show,
      generatedAt: new Date(deps.now()).toISOString(),
    };
    if (show.includes('counts')) {
      const c = await tx.query<{ type: string; status: string; n: string | number }>(
        `select type, status, count(*) as n from memories where project_id = $1 and status in ('confirmed','proposed','contested','stale') group by type, status`,
        [projectId],
      );
      const byType: Record<string, number> = {};
      const byStatus: Record<string, number> = {};
      let total = 0;
      for (const r of c.rows) {
        const n = Number(r.n);
        total += n;
        byType[r.type] = (byType[r.type] ?? 0) + n;
        byStatus[r.status] = (byStatus[r.status] ?? 0) + n;
      }
      out.counts = { total, byType, byStatus };
    }
    if (show.includes('memories')) {
      const rows = await tx.query<MemoryRow>(
        `select * from memories where project_id = $1 and status = 'confirmed' and expired = false order by confidence desc, updated_at desc limit ${MAX_MEMORIES}`,
        [projectId],
      );
      const recs = await loadMemories(tx, rows.rows);
      const ev = show.includes('evidence')
        ? await tx.query<{
            memory_id: string;
            kind: string;
            ref: Record<string, unknown>;
            last_result: string | null;
          }>(`select memory_id, kind, ref, last_result from evidence where memory_id = any($1) order by id`, [
            rows.rows.map((r) => r.id),
          ])
        : null;
      out.memories = recs.map((m) => ({
        id: m.id,
        type: m.type,
        text: m.text,
        confidence: Math.round(m.confidence * 100) / 100,
        branch: m.branch,
        createdAt: new Date(m.createdAt).toISOString(),
        ...(ev
          ? {
              evidence: ev.rows
                .filter((e) => e.memory_id === m.id)
                .map((e) => ({
                  kind: e.kind,
                  label: String(e.ref.digest ?? e.ref.id ?? e.ref.path ?? e.ref.href ?? e.ref.name ?? e.kind),
                  result:
                    e.last_result === 'pass' ? 'verified' : e.last_result === 'fail' ? 'failed' : 'unchecked',
                })),
            }
          : {}),
        ...(show.includes('storage')
          ? {
              blobId: m.blobId ?? null,
              expiresAt: m.expiresAt ? new Date(m.expiresAt).toISOString() : null,
            }
          : {}),
      }));
    }
    if (show.includes('storage')) {
      const s = await tx.query<{ n: string | number; soonest: Date | null }>(
        `select count(*) filter (where walrus_blob_id is not null) as n, min(expires_at) filter (where expired = false) as soonest from memories where project_id = $1`,
        [projectId],
      );
      out.storage = {
        storedMemories: Number(s.rows[0]?.n ?? 0),
        soonestExpiry: s.rows[0]?.soonest ? new Date(s.rows[0].soonest).toISOString() : null,
        mode: project.walrus_mode,
      };
    }
    return out;
  });
}
