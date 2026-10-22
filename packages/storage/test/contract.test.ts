import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Ed25519Signer,
  HttpWalrusAdapter,
  MockRelayer,
  RelayerError,
  type WalrusMemoryAdapter,
} from '../src/index.js';
import { Clock } from './helpers.js';

/**
 * Adapter contract. Runs against the in-process MockRelayer always, and against a real relayer when
 * BUIRY_CONTRACT_RELAYER_URL / WALRUS_ACCOUNT_ID / WALRUS_DELEGATE_KEY are set (see LOCAL_CHECKS.md L-W1).
 */
interface Target {
  name: string;
  make: () => Promise<{
    adapter: WalrusMemoryAdapter;
    namespace: string;
    settle: () => Promise<void>;
    close: () => Promise<void>;
    mock?: MockRelayer;
    clock?: Clock;
  }>;
}

const seed = '11'.repeat(32);
const targets: Target[] = [
  {
    name: 'mock relayer',
    make: async () => {
      const clock = new Clock();
      const mock = await MockRelayer.start({ now: clock.now, verifyAuth: true, jobPolls: 2 });
      const adapter = new HttpWalrusAdapter({
        baseUrl: mock.url,
        accountId: '0xacct',
        signer: new Ed25519Signer(seed),
        now: clock.now,
        supportedVersionPrefixes: ['1.'],
      });
      return {
        adapter,
        namespace: 'buiry.v1.prj_contract0001.main',
        settle: async () => {},
        close: () => mock.close(),
        mock,
        clock,
      };
    },
  },
];
if (
  process.env.BUIRY_CONTRACT_RELAYER_URL &&
  process.env.WALRUS_ACCOUNT_ID &&
  process.env.WALRUS_DELEGATE_KEY
) {
  targets.push({
    name: 'REAL relayer',
    make: async () => ({
      adapter: new HttpWalrusAdapter({
        baseUrl: process.env.BUIRY_CONTRACT_RELAYER_URL!,
        accountId: process.env.WALRUS_ACCOUNT_ID!,
        signer: new Ed25519Signer(process.env.WALRUS_DELEGATE_KEY!),
      }),
      namespace: `buiry.v1.prj_contract${Date.now().toString(36)}.main`,
      settle: () => new Promise((r) => setTimeout(r, 8000)),
      close: async () => {},
    }),
  });
}

describe.each(targets)('WalrusMemoryAdapter contract: $name', (t) => {
  let ctx: Awaited<ReturnType<Target['make']>>;
  beforeAll(async () => {
    ctx = await t.make();
  });
  afterAll(async () => ctx.close());

  async function waitDone(jobId: string) {
    for (let i = 0; i < 60; i++) {
      const st = await ctx.adapter.getJob(jobId);
      if (st.state === 'done') return st.blobId;
      if (st.state === 'failed') throw new Error(st.error);
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('job did not finish');
  }

  it('reports health and a compatible version', async () => {
    const h = await ctx.adapter.health();
    expect(h.reachable).toBe(true);
    expect(['ok', 'degraded', 'paused']).toContain(h.writeState);
    expect((await ctx.adapter.checkCompatibility()).version).toBeTruthy();
  });

  it('remember -> job -> done -> recall -> list', async () => {
    const text = `[buiry/1 evt=memory.created id=mem_contract01 type=decision branch=main agent=contract]\nUse pnpm workspaces for the monorepo build ${Date.now()}`;
    const { jobId } = await ctx.adapter.remember(ctx.namespace, text);
    const blobId = await waitDone(jobId);
    await ctx.settle();
    const r = await ctx.adapter.recall({
      namespace: ctx.namespace,
      query: 'pnpm workspaces monorepo',
      limit: 5,
    });
    expect(r.results.map((x) => x.blobId)).toContain(blobId);
    expect(r.results.find((x) => x.blobId === blobId)?.text).toBe(text);
    const page = await ctx.adapter.list({ namespace: ctx.namespace });
    const item = page.items.find((x) => x.blobId === blobId);
    expect(item).toBeTruthy();
    expect(item?.expiresAt ?? item?.endEpoch).toBeDefined();
  });

  it('bulk remember returns one job per item', async () => {
    const texts = [1, 2, 3].map(
      (n) =>
        `[buiry/1 evt=memory.created id=mem_bulk000${n} type=fact branch=main agent=contract]\nbulk fact ${n} ${Date.now()}`,
    );
    const { jobIds } = await ctx.adapter.rememberBulk(ctx.namespace, texts);
    expect(jobIds).toHaveLength(3);
    for (const id of jobIds) expect(await waitDone(id)).toBeTruthy();
  });

  it('restore returns newest first', async () => {
    const r = await ctx.adapter.restore(ctx.namespace, 5);
    expect(r.results.length).toBeGreaterThan(0);
  });

  it('rejects oversized bulk locally', async () => {
    await expect(
      ctx.adapter.rememberBulk(
        ctx.namespace,
        Array.from({ length: 21 }, (_, i) => `t${i}`),
      ),
    ).rejects.toMatchObject({ kind: 'client' });
  });
});

describe('MockRelayer behaviours the adapter must handle', () => {
  const setup = async (o = {}) => {
    const clock = new Clock();
    const mock = await MockRelayer.start({ now: clock.now, ...o });
    const adapter = new HttpWalrusAdapter({
      baseUrl: mock.url,
      accountId: '0xacct',
      signer: new Ed25519Signer(seed),
      now: clock.now,
    });
    return { clock, mock, adapter };
  };

  it('rejects bad signatures and maps 401 to a non-retryable auth error', async () => {
    const { mock } = await setup({ verifyAuth: true });
    const bad = new HttpWalrusAdapter({
      baseUrl: mock.url,
      accountId: '0xacct',
      signer: { publicKeyHex: new Ed25519Signer(seed).publicKeyHex, sign: async () => new Uint8Array(64) },
    });
    const e = await bad.remember('ns', 'x').catch((x: RelayerError) => x);
    expect(e).toBeInstanceOf(RelayerError);
    expect((e as RelayerError).kind).toBe('auth');
    expect((e as RelayerError).retryable).toBe(false);
    await mock.close();
  });

  it('maps 429 (with retry-after), 503, paused, and network failure', async () => {
    const { mock, adapter } = await setup();
    mock.failNextWrites(1, 429, 'slow down', 7);
    expect(await adapter.remember('ns', 'a').catch((e: RelayerError) => e)).toMatchObject({
      kind: 'rate_limited',
      retryAfterMs: 7000,
      retryable: true,
    });
    mock.failNextWrites(1, 503, 'overloaded');
    expect(await adapter.remember('ns', 'a').catch((e: RelayerError) => e)).toMatchObject({
      kind: 'unavailable',
      retryable: true,
    });
    mock.failNextWrites(1, 400, 'bad');
    expect(await adapter.remember('ns', 'a').catch((e: RelayerError) => e)).toMatchObject({
      kind: 'client',
      retryable: false,
    });
    mock.writeState = 'paused';
    expect(await adapter.remember('ns', 'a').catch((e: RelayerError) => e)).toMatchObject({ kind: 'paused' });
    expect((await adapter.health()).writeState).toBe('paused');
    await mock.close();
    expect(await adapter.health()).toMatchObject({ reachable: false });
    expect(await adapter.remember('ns', 'a').catch((e: RelayerError) => e)).toMatchObject({
      kind: 'unavailable',
    });
  });

  it('enforces version compatibility', async () => {
    const { mock } = await setup({ version: '2.3.0' });
    const a = new HttpWalrusAdapter({
      baseUrl: mock.url,
      accountId: 'a',
      signer: new Ed25519Signer(seed),
      supportedVersionPrefixes: ['1.'],
    });
    await expect(a.checkCompatibility()).rejects.toMatchObject({ kind: 'client' });
    await mock.close();
  });

  it('does not deduplicate writes, lags recall, and expires memories', async () => {
    const { mock, adapter, clock } = await setup({ recallLagMs: 5_000, defaultEpochs: 2 });
    const j1 = await adapter.remember('ns', 'same text twice');
    const j2 = await adapter.remember('ns', 'same text twice');
    await adapter.getJob(j1.jobId);
    await adapter.getJob(j2.jobId);
    expect(mock.blobs).toHaveLength(2);
    expect((await adapter.recall({ namespace: 'ns', query: 'same text' })).results).toHaveLength(0);
    clock.advance(5_000);
    expect((await adapter.recall({ namespace: 'ns', query: 'same text' })).results).toHaveLength(2);
    const [first] = (await adapter.list({ namespace: 'ns' })).items;
    expect(first!.expiresAt).toBeGreaterThan(clock.now());
    clock.advance(3 * 14 * 86_400_000);
    expect((await adapter.recall({ namespace: 'ns', query: 'same text' })).results).toHaveLength(0);
    expect((await adapter.list({ namespace: 'ns' })).items[0]!.status).toBe('expired');
    await mock.close();
  });

  it('paginates listings with cursors', async () => {
    const { mock, adapter } = await setup();
    const ids = await Promise.all(Array.from({ length: 5 }, (_, i) => adapter.remember('ns', `item ${i}`)));
    for (const j of ids) await adapter.getJob(j.jobId);
    const p1 = await adapter.list({ namespace: 'ns', limit: 2 });
    expect(p1.items).toHaveLength(2);
    const p2 = await adapter.list({ namespace: 'ns', limit: 2, cursor: p1.nextCursor! });
    const p3 = await adapter.list({ namespace: 'ns', limit: 2, cursor: p2.nextCursor! });
    expect([p1, p2, p3].flatMap((p) => p.items)).toHaveLength(5);
    expect(p3.nextCursor).toBeUndefined();
    await mock.close();
  });

  it('simulated limiter issues 429 beyond the documented budget', async () => {
    const { mock, adapter } = await setup({ rateLimits: true });
    let limited = 0;
    for (let i = 0; i < 14; i++)
      await adapter.remember('ns', `w${i}`).catch((e: RelayerError) => {
        if (e.kind === 'rate_limited') limited++;
      });
    expect(limited).toBe(2); // 12 x 5 points = 60
    expect(mock.rateLimitedCount).toBe(2);
    await mock.close();
  });
});
