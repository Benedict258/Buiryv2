import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Ed25519Signer,
  verifyEd25519,
  HttpWalrusAdapter,
  MockRelayer,
  RelayerError,
  SealSessionProvider,
  type WalrusMemoryAdapter,
} from '../src/index.js';
import { createGatewayIfConfigured, suiNetwork } from '@buiry/chain';
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
      // Like the live relayer, recall decrypts only with a Seal session (A23).
      const mock = await MockRelayer.start({
        now: clock.now,
        verifyAuth: true,
        jobPolls: 2,
        requireSealSession: true,
      });
      const adapter = new HttpWalrusAdapter({
        baseUrl: mock.url,
        accountId: '0xacct',
        signer: new Ed25519Signer(seed),
        now: clock.now,
        supportedVersionPrefixes: ['1.'],
      });
      adapter.useSealSession(
        new SealSessionProvider({
          delegateKey: seed,
          relayerConfig: () => adapter.relayerConfig(),
          packageVersion: async () => '1',
        }),
      );
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
    make: async () => {
      const adapter = new HttpWalrusAdapter({
        baseUrl: process.env.BUIRY_CONTRACT_RELAYER_URL!,
        accountId: process.env.WALRUS_ACCOUNT_ID!,
        signer: new Ed25519Signer(process.env.WALRUS_DELEGATE_KEY!),
      });
      // The Seal session's one Sui read goes through the real chain gateway (TATUM_* variables), as in server.ts.
      const gateway = createGatewayIfConfigured(process.env as Record<string, string>);
      if (gateway)
        adapter.useSealSession(
          new SealSessionProvider({
            delegateKey: process.env.WALRUS_DELEGATE_KEY!,
            relayerConfig: () => adapter.relayerConfig(),
            packageVersion: async (id, network) => {
              const r = await gateway.getObject(id, { network: suiNetwork(network) });
              if (!r.value.found) throw new Error('relayer Seal package not found on chain');
              return String(r.value.object.version);
            },
          }),
        );
      return {
        adapter,
        namespace: `buiry.v1.prj_contract${Date.now().toString(36)}.main`,
        settle: () => new Promise((r) => setTimeout(r, 8000)),
        close: async () => gateway?.close(),
      };
    },
  });
}

describe.each(targets)('WalrusMemoryAdapter contract: $name', (t) => {
  let ctx: Awaited<ReturnType<Target['make']>>;
  beforeAll(async () => {
    ctx = await t.make();
  });
  afterAll(async () => ctx.close());

  async function waitDone(jobId: string) {
    // A real write is Seal-encrypted and uploaded to Walrus, so it needs seconds, not the mock's milliseconds.
    const real = t.name.startsWith('REAL');
    for (let i = 0; i < (real ? 90 : 60); i++) {
      const st = await ctx.adapter.getJob(jobId);
      if (st.state === 'done') return st.blobId;
      if (st.state === 'failed') throw new Error(st.error);
      await new Promise((r) => setTimeout(r, real ? 2000 : 200));
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
    expect(r.degraded).toBeUndefined();
    expect(r.results.map((x) => x.blobId)).toContain(blobId);
    expect(r.results.find((x) => x.blobId === blobId)?.text).toBe(text);
    // Live, `end_epoch` and `expires_at` are null for a few minutes after the write (L-W2), so poll for them.
    const real = t.name.startsWith('REAL');
    let item: Awaited<ReturnType<typeof ctx.adapter.list>>['items'][number] | undefined;
    for (let i = 0; i < (real ? 40 : 1); i++) {
      const page = await ctx.adapter.list({ namespace: ctx.namespace });
      item = page.items.find((x) => x.blobId === blobId);
      if (item && (item.expiresAt ?? item.endEpoch) !== undefined) break;
      if (real) await new Promise((r) => setTimeout(r, 15_000));
    }
    expect(item).toBeTruthy();
    expect(item?.expiresAt ?? item?.endEpoch).toBeDefined();
  }, 900_000);

  it('bulk remember returns one job per item', async () => {
    const texts = [1, 2, 3].map(
      (n) =>
        `[buiry/1 evt=memory.created id=mem_bulk000${n} type=fact branch=main agent=contract]\nbulk fact ${n} ${Date.now()}`,
    );
    const { jobIds } = await ctx.adapter.rememberBulk(ctx.namespace, texts);
    expect(jobIds).toHaveLength(3);
    for (const id of jobIds) expect(await waitDone(id)).toBeTruthy();
  });

  it('restore reports counts only and never fails the blobs it inspects', async () => {
    const r = await ctx.adapter.restore(ctx.namespace, 5);
    expect(r.total).toBeGreaterThan(0);
    expect(r.restored + r.skipped + r.failed).toBeLessThanOrEqual(r.total);
    expect(r).not.toHaveProperty('results');
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
    const { mock, clock } = await setup({ verifyAuth: true });
    const bad = new HttpWalrusAdapter({
      baseUrl: mock.url,
      accountId: '0xacct',
      now: clock.now,
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

  // Regression tests encoding the relayer behaviour documented at docs.wal.app (A13, A14), read 2026-10-28.
  describe('documented wire format', () => {
    const NONCE = '3b241101-e2bb-4255-8caf-4136c566a962';
    const capture = () => {
      const seen: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
      const f = (async (url: string, init: RequestInit) => {
        seen.push({
          url,
          method: String(init.method),
          headers: init.headers as Record<string, string>,
          ...(typeof init.body === 'string' ? { body: init.body } : {}),
        });
        const path = new URL(url).pathname;
        const json = path.endsWith('/stats')
          ? { owner: '0x' + 'b'.repeat(64) }
          : path.startsWith('/v1/owners')
            ? { memories: [], deleted: [], has_more: false }
            : { job_id: 'j1', status: 'running' };
        return new Response(JSON.stringify(json), { status: 200 });
      }) as unknown as typeof fetch;
      return { seen, f };
    };
    const make = (f: typeof fetch) =>
      new HttpWalrusAdapter({
        baseUrl: 'https://relayer.example/',
        accountId: '0xacct',
        signer: new Ed25519Signer(seed),
        fetch: f,
        now: () => 1_700_000_000_000,
        nonce: () => NONCE,
      });

    it('signs {ts}.{METHOD}.{path+query}.{sha256(body)}.{nonce}.{account} and sends the documented headers', async () => {
      const { seen, f } = capture();
      await make(f).remember('ns', 'hello', { idempotencyKey: 'k1' });
      const r = seen[0]!;
      expect(r.url).toBe('https://relayer.example/api/remember');
      expect(
        Object.keys(r.headers)
          .filter((h) => h.startsWith('x-'))
          .sort(),
      ).toEqual(['x-account-id', 'x-nonce', 'x-public-key', 'x-signature', 'x-timestamp']);
      expect(r.headers['x-delegate-key']).toBeUndefined();
      expect(r.headers['x-timestamp']).toBe('1700000000');
      expect(r.headers['x-nonce']).toBe(NONCE);
      expect(JSON.parse(r.body!)).toEqual({ text: 'hello', namespace: 'ns', idempotency_key: 'k1' });
      const bodyHash = createHash('sha256').update(r.body!).digest('hex');
      const message = `1700000000.POST./api/remember.${bodyHash}.${NONCE}.0xacct`;
      expect(
        verifyEd25519(
          new Ed25519Signer(seed).publicKeyHex,
          new TextEncoder().encode(message),
          Buffer.from(r.headers['x-signature']!, 'hex'),
        ),
      ).toBe(true);
    });

    it('signs the query string with a GET and hashes the empty body', async () => {
      const { seen, f } = capture();
      await make(f).list({ namespace: 'ns', cursor: '7', limit: 2 });
      const stats = seen[0]!;
      const get = seen[1]!;
      expect(stats.url).toBe('https://relayer.example/api/stats');
      expect(get.url).toBe(
        `https://relayer.example/v1/owners/0x${'b'.repeat(64)}/memories?updated_after=7&limit=2`,
      );
      const emptyHash = createHash('sha256').update('').digest('hex');
      const message = `1700000000.GET./v1/owners/0x${'b'.repeat(64)}/memories?updated_after=7&limit=2.${emptyHash}.${NONCE}.0xacct`;
      expect(
        verifyEd25519(
          new Ed25519Signer(seed).publicKeyHex,
          new TextEncoder().encode(message),
          Buffer.from(get.headers['x-signature']!, 'hex'),
        ),
      ).toBe(true);
    });

    it('uses a fresh nonce per request and the relayer rejects a replayed one', async () => {
      const { mock, adapter, clock } = await setup({ verifyAuth: true });
      await expect(adapter.remember('ns', 'a')).resolves.toBeTruthy();
      await expect(adapter.remember('ns', 'b')).resolves.toBeTruthy();
      const replay = new HttpWalrusAdapter({
        baseUrl: mock.url,
        accountId: '0xacct',
        signer: new Ed25519Signer(seed),
        now: clock.now,
        nonce: () => NONCE,
      });
      await expect(replay.remember('ns', 'c')).resolves.toBeTruthy();
      await expect(replay.remember('ns', 'd')).rejects.toMatchObject({ kind: 'auth' });
      await mock.close();
    });

    it('rejects a request carrying the deprecated private-key header', async () => {
      const { mock } = await setup({ verifyAuth: true });
      const res = await fetch(mock.url + '/api/stats', {
        method: 'POST',
        headers: { 'x-delegate-key': 'deadbeef' },
        body: '{}',
      });
      expect(res.status).toBe(401);
      await mock.close();
    });

    it('collapses a repeated idempotency key onto one job and refuses key reuse with other text', async () => {
      const { mock, adapter } = await setup();
      const a = await adapter.remember('ns', 'same', { idempotencyKey: 'k' });
      const b = await adapter.remember('ns', 'same', { idempotencyKey: 'k' });
      expect(b.jobId).toBe(a.jobId);
      await expect(adapter.remember('ns', 'different', { idempotencyKey: 'k' })).rejects.toMatchObject({
        kind: 'client',
        status: 409,
      });
      const bulk1 = await adapter.rememberBulk('ns', ['x', 'y'], { idempotencyKey: 'bk' });
      const bulk2 = await adapter.rememberBulk('ns', ['x', 'y'], { idempotencyKey: 'bk' });
      expect(bulk2.jobIds).toEqual(bulk1.jobIds);
      await mock.close();
    });

    it('treats the intermediate "uploaded" status as not done, and reads the blob id only from "done"', async () => {
      const { mock, adapter, clock } = await setup({ autoCompleteMs: 5_000 });
      const { jobId } = await adapter.remember('ns', 'slow');
      expect(await adapter.getJob(jobId)).toEqual({ state: 'running' });
      clock.advance(5_000);
      expect((await adapter.getJob(jobId)).state).toBe('done');
      await mock.close();
    });

    it('takes the retry delay from retry_after_seconds in the body when there is no header', async () => {
      const f = (async () =>
        new Response(JSON.stringify({ error: 'slow down', retry_after_seconds: 12 }), {
          status: 429,
        })) as unknown as typeof fetch;
      expect(
        await make(f)
          .remember('ns', 'a')
          .catch((e: RelayerError) => e),
      ).toMatchObject({
        kind: 'rate_limited',
        retryAfterMs: 12_000,
      });
    });

    it('maps a recall deadline to a timeout and reads distance, not score', async () => {
      const timeout = (async () =>
        new Response(JSON.stringify({ error: 'x', code: 'RECALL_TIMEOUT', stage: 'embed' }), {
          status: 504,
        })) as unknown as typeof fetch;
      expect(
        await make(timeout)
          .recall({ namespace: 'ns', query: 'q' })
          .catch((e: RelayerError) => e),
      ).toMatchObject({
        kind: 'timeout',
      });
      const ok = (async () =>
        new Response(
          JSON.stringify({
            results: [{ blob_id: 'b1', text: 't', distance: 0.25, created_at: '2026-10-28T10:00:00Z' }],
            total: 1,
          }),
        )) as unknown as typeof fetch;
      const r = await make(ok).recall({ namespace: 'ns', query: 'q' });
      expect(r.results[0]).toEqual({
        blobId: 'b1',
        text: 't',
        distance: 0.25,
        createdAt: Date.parse('2026-10-28T10:00:00Z'),
      });
    });

    it('reports a degraded recall (HTTP 200, candidates dropped) instead of an empty match', async () => {
      // Shape seen live on the public relayer right after writes.
      const degraded = (async () =>
        new Response(
          JSON.stringify({ results: [], total: 0, dropped_count: 4, degraded: true }),
        )) as unknown as typeof fetch;
      const r = await make(degraded).recall({ namespace: 'ns', query: 'q' });
      expect(r).toEqual({ results: [], degraded: true, dropped: 4 });
    });

    it('accepts expires_at as epoch ms, epoch seconds or an RFC 3339 string', async () => {
      const page = (v: unknown) =>
        (async (url: string) =>
          new Response(
            JSON.stringify(
              url.endsWith('/api/stats')
                ? { owner: '0xo' }
                : { memories: [{ blob_id: 'b', namespace_id: 'ns', expires_at: v }], has_more: false },
            ),
          )) as unknown as typeof fetch;
      const ms = 1_800_000_000_000;
      for (const v of [ms, ms / 1000, new Date(ms).toISOString()]) {
        const out = await make(page(v)).list({ namespace: 'ns' });
        expect(out.items[0]!.expiresAt).toBe(ms);
      }
    });
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
