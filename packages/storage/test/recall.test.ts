import { afterEach, describe, expect, it } from 'vitest';
import {
  Ed25519Signer,
  EPOCH_MS,
  HttpWalrusAdapter,
  MockRelayer,
  RecallService,
  SealSessionProvider,
  reconcileExpiry,
  expiryMargin,
  type ExpiryStore,
  type IndexedMemory,
  type MemoryIndex,
  type Renewer,
} from '../src/index.js';
import { Clock, PROJECT, memText } from './helpers.js';

const open: MockRelayer[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

class FakeIndex implements MemoryIndex {
  rows = new Map<string, IndexedMemory>();
  put(m: Partial<IndexedMemory> & { id: string; text: string }, now: number): IndexedMemory {
    const row: IndexedMemory = {
      branch: 'main',
      type: 'decision',
      status: 'confirmed',
      confidence: 0.8,
      agent: 'claude-code-7f3a',
      createdAt: now,
      updatedAt: now,
      lastReinforcedAt: now,
      evidence: [],
      writeState: 'stored',
      ...m,
    };
    this.rows.set(row.id, row);
    return row;
  }
  async getMany(ids: string[]) {
    return ids.flatMap((i) => (this.rows.has(i) ? [this.rows.get(i)!] : []));
  }
  async searchLocal(q: { branches: string[]; limit: number }) {
    return [...this.rows.values()].filter((r) => q.branches.includes(r.branch)).slice(0, q.limit);
  }
}

async function rig(mockOpts = {}) {
  const clock = new Clock();
  const mock = await MockRelayer.start({ now: clock.now, autoCompleteMs: 0, ...mockOpts });
  open.push(mock);
  const adapter = new HttpWalrusAdapter({
    baseUrl: mock.url,
    accountId: 'a',
    signer: new Ed25519Signer('33'.repeat(32)),
    now: clock.now,
  });
  const index = new FakeIndex();
  const svc = new RecallService(adapter, index);
  const ns = (b: string) => `buiry.v1.${PROJECT}.${b}`;
  const write = async (id: string, body: string, branch = 'main', o: Partial<IndexedMemory> = {}) => {
    await adapter.remember(ns(branch), memText(id, body, { branch }).text);
    index.put({ id, text: body, branch, ...o }, clock.now());
  };
  return { clock, mock, adapter, index, svc, write, ns };
}

describe('recall service', () => {
  it('merges the branch and main, merges Buiry confidence/status, and ranks by relevance + confidence', async () => {
    const { svc, write, clock } = await rig();
    await write('mem_main_1', 'Use pnpm workspaces for the monorepo build.');
    await write('mem_feat_1', 'Feature branch uses pnpm workspaces filters.', 'feat-auth', {
      status: 'proposed',
      confidence: 0.35,
    });
    const r = await svc.recall({
      projectId: PROJECT,
      branch: 'feat-auth',
      query: 'pnpm workspaces',
      now: clock.now(),
    });
    expect(r.servedFromCache).toBe(false);
    expect(r.results.map((x) => x.memoryId).sort()).toEqual(['mem_feat_1', 'mem_main_1']);
    expect(r.results[0]!.memoryId).toBe('mem_main_1'); // confirmed 0.8 outranks proposed 0.35
    expect(r.results.find((x) => x.memoryId === 'mem_feat_1')!.status).toBe('proposed');
  });

  it('never returns tombstoned, superseded or expired memories, and respects branch shadowing', async () => {
    const { svc, write, clock } = await rig();
    await write('mem_a', 'Store sessions in the database.');
    await write('mem_b', 'Store sessions in the database old.', 'main', { status: 'tombstoned' });
    await write('mem_c', 'Store sessions in the database older.', 'main', { status: 'superseded' });
    await write('mem_d', 'Store sessions in the database lapsed.', 'main', { expired: true });
    await write('mem_e', 'Store sessions in Redis instead of the database.', 'feat-x', {
      supersedesId: 'mem_a',
    });
    const r = await svc.recall({
      projectId: PROJECT,
      branch: 'feat-x',
      query: 'store sessions database',
      now: clock.now(),
    });
    expect(r.results.map((x) => x.memoryId)).toEqual(['mem_e']);
  });

  it('filters by type and status', async () => {
    const { svc, write, clock } = await rig();
    await write('mem_f', 'Migration in one transaction exceeded gas.', 'main', { type: 'failure' });
    await write('mem_g', 'Migration plan uses batches.', 'main', { type: 'decision', status: 'proposed' });
    expect(
      (
        await svc.recall({
          projectId: PROJECT,
          branch: 'main',
          query: 'migration',
          type: 'failure',
          now: clock.now(),
        })
      ).results.map((x) => x.memoryId),
    ).toEqual(['mem_f']);
    expect(
      (
        await svc.recall({
          projectId: PROJECT,
          branch: 'main',
          query: 'migration',
          status: ['proposed'],
          now: clock.now(),
        })
      ).results.map((x) => x.memoryId),
    ).toEqual(['mem_g']);
  });

  it('includes just-written memories the relayer cannot recall yet (recall lag)', async () => {
    const { svc, write, clock } = await rig({ recallLagMs: 10_000 });
    await write('mem_h', 'Freshly written decision about caching.', 'main', { writeState: 'queued' });
    const r = await svc.recall({
      projectId: PROJECT,
      branch: 'main',
      query: 'caching decision',
      now: clock.now(),
    });
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ memoryId: 'mem_h', writeState: 'queued' });
  });

  it('serves from the index and says so when the relayer is down', async () => {
    const { svc, write, clock, mock } = await rig();
    await write('mem_i', 'Registry package deployed on mainnet.');
    await mock.close();
    open.pop();
    const r = await svc.recall({
      projectId: PROJECT,
      branch: 'main',
      query: 'registry package',
      now: clock.now(),
    });
    expect(r.servedFromCache).toBe(true);
    expect(r.results.map((x) => x.memoryId)).toEqual(['mem_i']);
  });

  it('flags mayHaveMore when a namespace returns exactly the limit', async () => {
    const { svc, write, clock } = await rig();
    for (let i = 0; i < 3; i++) await write(`mem_j${i}`, `Convention number ${i} about naming.`);
    expect(
      (
        await svc.recall({
          projectId: PROJECT,
          branch: 'main',
          query: 'convention naming',
          limit: 3,
          now: clock.now(),
        })
      ).mayHaveMore,
    ).toBe(true);
    expect(
      (
        await svc.recall({
          projectId: PROJECT,
          branch: 'main',
          query: 'convention naming',
          limit: 10,
          now: clock.now(),
        })
      ).mayHaveMore,
    ).toBe(false);
  });

  it('surfaces memories found on Walrus but absent from the index as unindexed proposals', async () => {
    const { svc, adapter, ns, clock } = await rig();
    await adapter.remember(ns('main'), memText('mem_k', 'Orphan memory about rate limits.').text);
    const r = await svc.recall({
      projectId: PROJECT,
      branch: 'main',
      query: 'rate limits',
      now: clock.now(),
    });
    expect(r.results[0]).toMatchObject({ memoryId: 'mem_k', status: 'proposed' });
    expect(r.results[0]!.flags).toContain('not_indexed');
  });

  it('ignores non-created events and malformed records returned by the relayer', async () => {
    const { svc, adapter, ns, clock } = await rig();
    await adapter.remember(
      ns('main'),
      memText('mem_l', 'Tombstone notice', { evt: 'memory.tombstoned' }).text,
    );
    await adapter.remember(ns('main'), 'plain text with no header about tombstone notice');
    expect(
      (await svc.recall({ projectId: PROJECT, branch: 'main', query: 'tombstone notice', now: clock.now() }))
        .results,
    ).toEqual([]);
  });
});

describe('expiry reconciliation', () => {
  class Store implements ExpiryStore {
    expired: string[] = [];
    expiry = new Map<string, object>();
    constructor(public refs: { memoryId: string; blobId: string; namespace: string }[]) {}
    async listStoredMemories() {
      return this.refs;
    }
    async setExpiry(id: string, e: object) {
      this.expiry.set(id, e);
    }
    async markExpired(id: string) {
      this.expired.push(id);
    }
  }

  it('picks up expiry on a later scan when the relayer reports it minutes after the write (live behaviour)', async () => {
    const clock = new Clock();
    const mock = await MockRelayer.start({ now: clock.now, autoCompleteMs: 0, expiryLagMs: 5 * 60_000 });
    open.push(mock);
    const adapter = new HttpWalrusAdapter({
      baseUrl: mock.url,
      accountId: 'a',
      signer: new Ed25519Signer('33'.repeat(32)),
      now: clock.now,
    });
    const ns = `buiry.v1.${PROJECT}.main`;
    await adapter.remember(ns, 'fresh');
    const store = new Store([{ memoryId: 'mem_0', blobId: mock.blobs[0]!.blobId, namespace: ns }]);
    await reconcileExpiry({ adapter, store, now: clock.now(), checkIntervalMs: 6 * 3_600_000 });
    expect(store.expiry.get('mem_0')).toEqual({}); // nothing known yet
    clock.advance(6 * 60_000);
    await reconcileExpiry({ adapter, store, now: clock.now(), checkIntervalMs: 6 * 3_600_000 });
    expect(store.expiry.get('mem_0')).toMatchObject({
      endEpoch: expect.any(Number),
      expiresAt: expect.any(Number),
    });
  });

  it('records expiry, flags expiring within the margin and expired memories', async () => {
    const clock = new Clock();
    const mock = await MockRelayer.start({ now: clock.now, autoCompleteMs: 0, defaultEpochs: 3 });
    open.push(mock);
    const adapter = new HttpWalrusAdapter({
      baseUrl: mock.url,
      accountId: 'a',
      signer: new Ed25519Signer('33'.repeat(32)),
      now: clock.now,
    });
    const ns = `buiry.v1.${PROJECT}.main`;
    await adapter.remember(ns, 'one');
    await adapter.remember(ns, 'two');
    const refs = mock.blobs.map((b, i) => ({ memoryId: `mem_${i}`, blobId: b.blobId, namespace: ns }));
    const store = new Store(refs);

    // fresh: 3 epochs remain (> 2 epoch margin), nothing flagged
    let rep = await reconcileExpiry({ adapter, store, now: clock.now(), checkIntervalMs: 6 * 3_600_000 });
    expect(rep).toMatchObject({ expiring: [], expired: [], scanned: 2 });
    expect(store.expiry.size).toBe(2);

    clock.advance(EPOCH_MS * 1.5); // inside the two-epoch margin
    rep = await reconcileExpiry({ adapter, store, now: clock.now(), checkIntervalMs: 6 * 3_600_000 });
    expect(rep.expiring.map((e) => e.memoryId).sort()).toEqual(['mem_0', 'mem_1']);

    clock.advance(EPOCH_MS * 3);
    rep = await reconcileExpiry({ adapter, store, now: clock.now(), checkIntervalMs: 6 * 3_600_000 });
    expect(rep.expired.sort()).toEqual(['mem_0', 'mem_1']);
    expect(store.expired.sort()).toEqual(['mem_0', 'mem_1']);
  });

  it('reports unknown (missing) and hard-deleted blobs, and paginates the listing', async () => {
    const clock = new Clock();
    const mock = await MockRelayer.start({ now: clock.now, autoCompleteMs: 0 });
    open.push(mock);
    const adapter = new HttpWalrusAdapter({
      baseUrl: mock.url,
      accountId: 'a',
      signer: new Ed25519Signer('33'.repeat(32)),
      now: clock.now,
    });
    const ns = `buiry.v1.${PROJECT}.main`;
    for (let i = 0; i < 120; i++) await adapter.remember(ns, `memory ${i}`);
    mock.hardDeleted.push(mock.blobs[0]!.blobId);
    const refs = [
      { memoryId: 'mem_deleted', blobId: mock.blobs[0]!.blobId, namespace: ns },
      { memoryId: 'mem_late', blobId: mock.blobs[119]!.blobId, namespace: ns },
      { memoryId: 'mem_ghost', blobId: 'blob_unknown', namespace: ns },
    ];
    const rep = await reconcileExpiry({
      adapter,
      store: new Store(refs),
      now: clock.now(),
      checkIntervalMs: 3_600_000,
    });
    expect(rep.deleted).toEqual(['mem_deleted']);
    expect(rep.missing).toEqual(['mem_ghost']);
    expect(rep.scanned).toBe(3);
  });

  it('renewal is behind a feature flag', async () => {
    const clock = new Clock();
    const mock = await MockRelayer.start({ now: clock.now, autoCompleteMs: 0, defaultEpochs: 1 });
    open.push(mock);
    const adapter = new HttpWalrusAdapter({
      baseUrl: mock.url,
      accountId: 'a',
      signer: new Ed25519Signer('33'.repeat(32)),
      now: clock.now,
    });
    const ns = `buiry.v1.${PROJECT}.main`;
    await adapter.remember(ns, 'x');
    const store = new Store([{ memoryId: 'mem_0', blobId: mock.blobs[0]!.blobId, namespace: ns }]);
    const calls: string[][] = [];
    const renewer: Renewer = { renew: async (ids) => (calls.push(ids), { renewed: ids, failed: [] }) };
    let rep = await reconcileExpiry({ adapter, store, now: clock.now(), checkIntervalMs: 1000, renewer });
    expect(calls).toEqual([]);
    expect(rep.expiring).toHaveLength(1);
    rep = await reconcileExpiry({
      adapter,
      store,
      now: clock.now(),
      checkIntervalMs: 1000,
      renewer,
      renewalEnabled: true,
    });
    expect(calls).toHaveLength(1);
    expect(rep).toMatchObject({ renewed: ['mem_0'], expiring: [] });
  });

  it('margin is at least two epochs and more than two check intervals', () => {
    expect(expiryMargin(3_600_000)).toBe(2 * EPOCH_MS);
    expect(expiryMargin(30 * 86_400_000)).toBeGreaterThan(2 * 30 * 86_400_000);
    // Testnet epochs are about a day: with a 6-hour scan the margin is two days, not 28 (5-day memories seen live).
    expect(expiryMargin(6 * 3_600_000, 'testnet')).toBe(2 * 86_400_000);
    expect(expiryMargin(6 * 3_600_000, 'mainnet')).toBe(2 * EPOCH_MS);
  });
});

describe('degraded relayer recall', () => {
  it('fills from the index and says so when the relayer drops every candidate', async () => {
    const { svc, write, clock, mock } = await rig();
    await write('mem_dg', 'Use pnpm workspaces for the monorepo build.');
    mock.recallDegraded = true;
    const r = await svc.recall({
      projectId: PROJECT,
      branch: 'main',
      query: 'pnpm workspaces monorepo',
      now: clock.now(),
    });
    expect(r.servedFromCache).toBe(true);
    expect(r.results.map((x) => x.memoryId)).toEqual(['mem_dg']);
  });
});

describe('A23: recall needs a client-built Seal session (cause confirmed live)', () => {
  // Live 2026-11-10: same account, delegate and namespace. Without `x-seal-session` the relayer dropped every
  // candidate (`degraded: true`, `dropped_count: 4`); the official SDK, which sends one, got all 4 with text.
  it('reproduces the live failure: without a session every candidate is dropped and recall is served from the index', async () => {
    const { svc, write, clock, adapter } = await rig({ requireSealSession: true });
    await write('mem_seal', 'Use pnpm workspaces for the monorepo build.');
    const raw = await adapter.recall({ namespace: `buiry.v1.${PROJECT}.main`, query: 'pnpm workspaces' });
    expect(raw).toMatchObject({ results: [], degraded: true, dropped: 1 });
    const r = await svc.recall({
      projectId: PROJECT,
      branch: 'main',
      query: 'pnpm workspaces',
      now: clock.now(),
    });
    expect(r.servedFromCache).toBe(true);
    expect(r.results.map((x) => x.memoryId)).toEqual(['mem_seal']);
  });

  it('returns relayer results when the adapter sends a Seal session', async () => {
    const { adapter, write } = await rig({ requireSealSession: true });
    adapter.useSealSession(
      new SealSessionProvider({
        delegateKey: '33'.repeat(32),
        relayerConfig: () => adapter.relayerConfig(),
        packageVersion: async () => '1',
      }),
    );
    await write('mem_seal2', 'Use pnpm workspaces for the monorepo build.');
    const raw = await adapter.recall({ namespace: `buiry.v1.${PROJECT}.main`, query: 'pnpm workspaces' });
    expect(raw.degraded).toBeUndefined();
    expect(raw.results).toHaveLength(1);
  });
});

describe('recall ranks person-confirmed memories ahead of agent-only ones at equal relevance (Phase 7.3)', () => {
  it('breaks an exact tie in favour of the confirmed memory, not by id', async () => {
    const { svc, write, clock } = await rig();
    await write('mem_a_agent', 'Store sessions in the database.', 'main', {
      status: 'proposed',
      confidence: 0.7,
    });
    await write('mem_b_person', 'Store sessions in the database.', 'main', {
      status: 'confirmed',
      confidence: 0.7,
    });
    const r = await svc.recall({
      projectId: PROJECT,
      branch: 'main',
      query: 'sessions database',
      now: clock.now(),
    });
    expect(r.results.map((x) => x.memoryId)).toEqual(['mem_b_person', 'mem_a_agent']);
  });
});

describe('recall: status first (Phase 8 B2)', () => {
  it('ranks a confirmed memory above an evidence-lifted agent-only one with higher relevance', async () => {
    const { svc, write, clock } = await rig();
    await write('mem_a_agent', 'Store sessions in the database session storage.', 'main', {
      status: 'proposed',
      confidence: 0.9,
    });
    await write('mem_b_person', 'Sessions live in the database.', 'main', {
      status: 'confirmed',
      confidence: 0.8,
    });
    const r = await svc.recall({
      projectId: PROJECT,
      branch: 'main',
      query: 'session storage database',
      now: clock.now(),
    });
    expect(r.results.map((x) => x.memoryId)).toEqual(['mem_b_person', 'mem_a_agent']);
  });
});

describe('recall: status first only among relevant results (Phase 9 A2)', () => {
  it('an irrelevant confirmed memory neither appears nor displaces a relevant proposed one', async () => {
    const { svc, write, clock } = await rig();
    await write('mem_a_relevant', 'Store sessions in the database session storage.', 'main', {
      status: 'proposed',
      confidence: 0.35,
    });
    await write('mem_b_offtopic', 'Release notes go in the changelog file.', 'main', {
      status: 'confirmed',
      confidence: 0.8,
    });
    const r = await svc.recall({
      projectId: PROJECT,
      branch: 'main',
      query: 'session storage database',
      now: clock.now(),
      limit: 2,
    });
    expect(r.results.map((x) => x.memoryId)).toEqual(['mem_a_relevant']);
  });
});
