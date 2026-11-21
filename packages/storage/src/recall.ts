import {
  DEFAULT_LEARNING,
  decodeMemory,
  deriveNamespace,
  effectiveConfidence,
  relevance,
  type Evidence,
  type LearningConfig,
  type MemoryRecord,
  type MemoryType,
  type Status,
  confirmedFirst,
} from '@buiry/core';
import type { WalrusMemoryAdapter } from './adapter.js';

export type WriteStateLabel = 'queued' | 'stored' | 'failed';

export interface IndexedMemory extends MemoryRecord {
  blobId?: string;
  writeState: WriteStateLabel;
}

/** Buiry's own index (Postgres in production). Walrus is the durable record; this is the cache. */
export interface MemoryIndex {
  searchLocal(q: {
    projectId: string;
    branches: string[];
    query: string;
    limit: number;
  }): Promise<IndexedMemory[]>;
  getMany(ids: string[]): Promise<IndexedMemory[]>;
}

export interface RecallInput {
  projectId: string;
  branch: string;
  query: string;
  type?: MemoryType;
  status?: Status[];
  limit?: number;
  now: number;
}

export interface RecallResultItem {
  memoryId: string;
  text: string;
  type: MemoryType;
  status: Status;
  confidence: number;
  flags: string[];
  evidence: Evidence[];
  branch: string;
  agent: string;
  writeState: WriteStateLabel;
}

export interface RecallOutput {
  results: RecallResultItem[];
  servedFromCache: boolean;
  mayHaveMore: boolean;
}

const HIDDEN: Status[] = ['superseded', 'tombstoned'];

export class RecallService {
  constructor(
    private readonly adapter: WalrusMemoryAdapter,
    private readonly index: MemoryIndex,
    private readonly cfg: LearningConfig = DEFAULT_LEARNING,
  ) {}

  async recall(i: RecallInput): Promise<RecallOutput> {
    const limit = Math.min(100, Math.max(1, i.limit ?? 10));
    const branches = i.branch === 'main' ? ['main'] : [i.branch, 'main'];
    const settled = await Promise.allSettled(
      branches.map((b) =>
        this.adapter.recall({ namespace: deriveNamespace(i.projectId, b), query: i.query, limit }),
      ),
    );
    const ok = settled.flatMap((s, idx) =>
      s.status === 'fulfilled'
        ? [{ branch: branches[idx]!, results: s.value.results, degraded: s.value.degraded === true }]
        : [],
    );
    // A degraded relayer answer (HTTP 200, candidates dropped) counts as unavailable for that namespace:
    // its results are used, but the index fills the gap and the caller is told it came from cache.
    const usable = ok.filter((o) => !o.degraded);
    const servedFromCache = usable.length === 0;
    const mayHaveMore = ok.some((o) => o.results.length >= limit);

    const relayerScore = new Map<string, number>();
    const unindexed = new Map<string, IndexedMemory>();
    const ids: string[] = [];
    for (const o of ok) {
      for (const r of o.results) {
        const d = decodeMemory(r.text);
        if (!d.ok || (d.value.header.evt !== 'memory.created' && d.value.header.evt !== 'handoff.created'))
          continue;
        const id = d.value.header.id;
        const score = r.score ?? relevance(i.query, d.value.body);
        relayerScore.set(id, Math.max(relayerScore.get(id) ?? 0, score));
        ids.push(id);
        if (!unindexed.has(id)) {
          unindexed.set(id, {
            id,
            branch: d.value.header.branch,
            type: d.value.header.type ?? 'fact',
            status: 'proposed',
            text: d.value.body,
            confidence: this.cfg.initialAgent,
            agent: d.value.header.agent,
            createdAt: r.createdAt ?? i.now,
            updatedAt: r.createdAt ?? i.now,
            lastReinforcedAt: r.createdAt ?? i.now,
            evidence: d.value.evidence,
            flags: ['not_indexed'],
            blobId: r.blobId,
            writeState: 'stored',
          });
        }
      }
    }

    const indexed = new Map((await this.index.getMany([...new Set(ids)])).map((m) => [m.id, m]));
    const local = await this.index.searchLocal({ projectId: i.projectId, branches, query: i.query, limit });
    const merged = new Map<string, IndexedMemory>();
    for (const id of new Set(ids)) merged.set(id, indexed.get(id) ?? unindexed.get(id)!);
    // Just-written memories the relayer cannot recall yet (or everything, when serving from cache).
    // Local-only additions must still be about the query; the index search can return recents as filler.
    for (const m of local) {
      if (
        !merged.has(m.id) &&
        (servedFromCache || m.writeState !== 'stored') &&
        relevance(i.query, m.text) > 0
      ) {
        merged.set(m.id, m);
      }
    }

    const shadowed = new Set(
      [...merged.values()].filter((m) => m.branch !== 'main' && m.supersedesId).map((m) => m.supersedesId!),
    );
    const wanted = i.status ?? (['proposed', 'confirmed', 'contested', 'stale'] as Status[]);

    const ranked = [...merged.values()]
      .filter((m) => !HIDDEN.includes(m.status) && !m.expired && !shadowed.has(m.id))
      .filter((m) => wanted.includes(m.status) && (!i.type || m.type === i.type))
      .map((m) => {
        const eff = effectiveConfidence(m, i.now, this.cfg);
        const rel = relayerScore.get(m.id) ?? relevance(i.query, m.text);
        return { m, eff, score: 0.6 * rel + 0.4 * eff };
      })
      // At an exact tie a person-confirmed memory goes first (Phase 7.3), then the id keeps the order stable.
      .sort((a, b) => b.score - a.score || confirmedFirst(a.m, b.m) || a.m.id.localeCompare(b.m.id))
      .slice(0, limit);

    return {
      results: ranked.map(({ m, eff }) => ({
        memoryId: m.id,
        text: m.text,
        type: m.type,
        status: m.status,
        confidence: Math.round(eff * 100) / 100,
        flags: [...(m.flags ?? []), ...(m.status === 'stale' || m.status === 'contested' ? [m.status] : [])],
        evidence: m.evidence,
        branch: m.branch,
        agent: m.agent,
        writeState: m.writeState,
      })),
      servedFromCache,
      mayHaveMore,
    };
  }
}
