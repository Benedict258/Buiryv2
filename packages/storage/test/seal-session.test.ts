import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Ed25519Signer, HttpWalrusAdapter, RelayerError, SealSessionProvider } from '../src/index.js';

// Test-only key, not a real account.
const KEY = '4e'.repeat(32);
const PKG = '0x' + '5e'.repeat(32);
const ADDRESS = Ed25519Keypair.fromSecretKey(Buffer.from(KEY, 'hex')).getPublicKey().toSuiAddress();

const decode = (h: string) =>
  JSON.parse(Buffer.from(h, 'base64').toString('utf8')) as Record<string, unknown>;

function provider(over: Partial<ConstructorParameters<typeof SealSessionProvider>[0]> = {}) {
  let t = 1_800_000_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const versionCalls: [string, string][] = [];
  const p = new SealSessionProvider({
    delegateKey: KEY,
    relayerConfig: async () => ({ packageId: PKG, network: 'mainnet' }),
    packageVersion: async (id, network) => {
      versionCalls.push([id, network]);
      return '1';
    },
    now: clock.now,
    ...over,
  });
  return { p, clock, versionCalls };
}

describe('Seal session provider (x-seal-session, A23)', () => {
  it('builds the exported SessionKey the official SDK sends, signed by the delegate key', async () => {
    const { p, versionCalls } = provider();
    const h = await p.header();
    const j = decode(h);
    expect(Object.keys(j).sort()).toEqual(
      ['address', 'creationTimeMs', 'packageId', 'personalMessageSignature', 'sessionKey', 'ttlMin'].sort(),
    );
    expect(j).toMatchObject({ address: ADDRESS, packageId: PKG, ttlMin: 5 });
    expect(typeof j.personalMessageSignature).toBe('string');
    // The one Sui read goes through the injected reader, for the relayer's package and network.
    expect(versionCalls).toEqual([[PKG, 'mainnet']]);
  });

  it('refuses a package that is not the first version, with a scrubbed message', async () => {
    const { p } = provider({ packageVersion: async () => '2' });
    const err = await p.header().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayerError);
    // Seal 1.5.2 reports this as "Package ID used in PTB is invalid"; only our prefix is asserted.
    expect((err as RelayerError).message).toMatch(/^seal session unavailable: /);
    expect((err as RelayerError).kind).toBe('unavailable');
  });

  it('caches the session below its 5-minute lifetime and refreshes 30 s before expiry', async () => {
    const { p, clock, versionCalls } = provider();
    const a = await p.header();
    clock.advance(4 * 60_000);
    expect(await p.header()).toBe(a);
    clock.advance(30_000); // 4.5 min: inside the refresh margin
    const b = await p.header();
    expect(b).not.toBe(a);
    expect(versionCalls).toHaveLength(2);
  });

  it('shares one build between concurrent callers and rebuilds after invalidate', async () => {
    const { p, versionCalls } = provider();
    const [a, b, c] = await Promise.all([p.header(), p.header(), p.header()]);
    expect(new Set([a, b, c]).size).toBe(1);
    expect(versionCalls).toHaveLength(1);
    p.invalidate();
    await p.header();
    expect(versionCalls).toHaveLength(2);
  });
});

describe('the delegate key and the session never appear in logs or errors', () => {
  const out: string[] = [];
  beforeEach(() => {
    out.length = 0;
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const)
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(' ')));
  });
  afterEach(() => vi.restoreAllMocks());

  const leaks = (text: string, secrets: string[]) => secrets.filter((s) => s && text.includes(s));
  const describeErr = (e: unknown) =>
    [
      String(e),
      (e as Error)?.message,
      (e as Error)?.stack,
      JSON.stringify(e),
      JSON.stringify((e as Error)?.cause ?? null),
    ].join('\n');

  it('scrubs a reader error that tries to carry the key', async () => {
    const { p } = provider({
      packageVersion: async () => {
        throw new Error(`lookup failed for ${KEY} / ${Buffer.from(KEY, 'hex').toString('base64')}`);
      },
    });
    const err = await p.header().catch((e: unknown) => e);
    expect((err as Error).message).toContain('[redacted]');
    expect((err as Error).cause).toBeUndefined();
    expect(leaks(describeErr(err), [KEY, Buffer.from(KEY, 'hex').toString('base64')])).toEqual([]);
    expect(JSON.stringify(p)).toBe('{}'); // no enumerable state
  });

  it('keeps the session out of adapter errors, even when the relayer echoes it back', async () => {
    const { p } = provider();
    const session = await p.header();
    const sessionSecret = String(decode(session).sessionKey);
    let calls = 0;
    const echo = (async (_url: string, init?: RequestInit) => {
      calls++;
      const sent = new Headers(init?.headers).get('x-seal-session') ?? '';
      const status = calls === 1 ? 500 : 401;
      return new Response(JSON.stringify({ error: `bad session ${sent} ${decode(sent).sessionKey}` }), {
        status,
      });
    }) as unknown as typeof fetch;
    const adapter = new HttpWalrusAdapter({
      baseUrl: 'https://relayer.example',
      accountId: '0xacct',
      signer: new Ed25519Signer(KEY),
      fetch: echo,
      sealSession: p,
      sleep: async () => {},
    });
    const e500 = await adapter.recall({ namespace: 'ns', query: 'q' }).catch((e: unknown) => e);
    const e401 = await adapter.recall({ namespace: 'ns', query: 'q' }).catch((e: unknown) => e);
    for (const e of [e500, e401]) {
      expect(e).toBeInstanceOf(RelayerError);
      expect(leaks(describeErr(e), [session, sessionSecret, KEY])).toEqual([]);
    }
    expect((e401 as RelayerError).kind).toBe('auth');
    // A rejected session is dropped, so the next call builds a fresh one.
    expect(await p.header()).not.toBe(session);
    expect(leaks(out.join('\n'), [session, sessionSecret, KEY])).toEqual([]);
  });

  it('logs nothing at all on the success path', async () => {
    const { p } = provider();
    const ok = (async () =>
      new Response(
        JSON.stringify({ results: [{ blob_id: 'b', text: 't', distance: 0.1 }], total: 1 }),
      )) as unknown as typeof fetch;
    const adapter = new HttpWalrusAdapter({
      baseUrl: 'https://relayer.example',
      accountId: '0xacct',
      signer: new Ed25519Signer(KEY),
      fetch: ok,
      sealSession: p,
    });
    expect((await adapter.recall({ namespace: 'ns', query: 'q' })).results).toHaveLength(1);
    expect(out).toEqual([]);
  });
});

describe('recall retries a timeout or unreachable relayer once, with backoff', () => {
  const unreachable = () =>
    Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
  const make = (f: typeof fetch, sleeps: number[]) =>
    new HttpWalrusAdapter({
      baseUrl: 'https://relayer.example',
      accountId: '0xacct',
      signer: new Ed25519Signer(KEY),
      fetch: f,
      sleep: async (ms) => void sleeps.push(ms),
    });

  it('recovers from one connect timeout (seen live) after a 500 ms backoff', async () => {
    let n = 0;
    const sleeps: number[] = [];
    const f = (async () => {
      if (n++ === 0) throw unreachable();
      return new Response(JSON.stringify({ results: [], total: 0 }));
    }) as unknown as typeof fetch;
    await expect(make(f, sleeps).recall({ namespace: 'ns', query: 'q' })).resolves.toMatchObject({
      results: [],
    });
    expect(n).toBe(2);
    expect(sleeps).toEqual([500]);
  });

  it('gives up after the retry and names the network cause', async () => {
    const sleeps: number[] = [];
    const f = (async () => {
      throw unreachable();
    }) as unknown as typeof fetch;
    const err = await make(f, sleeps)
      .recall({ namespace: 'ns', query: 'q' })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'unavailable' });
    expect((err as Error).message).toContain('(UND_ERR_CONNECT_TIMEOUT)');
    expect(sleeps).toEqual([500]);
  });

  it('does not retry an authentication failure', async () => {
    let n = 0;
    const f = (async () => {
      n++;
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    }) as unknown as typeof fetch;
    await expect(make(f, []).recall({ namespace: 'ns', query: 'q' })).rejects.toMatchObject({ kind: 'auth' });
    expect(n).toBe(1);
  });
});

describe('the signed listing also retries a connect timeout once', () => {
  it('recovers when the first stats call times out', async () => {
    let n = 0;
    const sleeps: number[] = [];
    const f = (async (url: string) => {
      n++;
      if (n === 1)
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
      if (String(url).endsWith('/api/stats')) return new Response(JSON.stringify({ owner: '0xowner' }));
      return new Response(JSON.stringify({ memories: [], has_more: false }));
    }) as unknown as typeof fetch;
    const adapter = new HttpWalrusAdapter({
      baseUrl: 'https://relayer.example',
      accountId: '0xacct',
      signer: new Ed25519Signer(KEY),
      fetch: f,
      sleep: async (ms) => void sleeps.push(ms),
    });
    await expect(adapter.list({})).resolves.toMatchObject({ items: [] });
    expect(sleeps).toEqual([500]);
    expect(n).toBe(3);
  });
});

describe('the relayer /config read also retries once', () => {
  it('recovers from a connect failure (seen at server startup on testnet)', async () => {
    let n = 0;
    const sleeps: number[] = [];
    const f = (async () => {
      if (n++ === 0)
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
      return new Response(JSON.stringify({ packageId: '0x' + '5e'.repeat(32), network: 'testnet' }));
    }) as unknown as typeof fetch;
    const adapter = new HttpWalrusAdapter({
      baseUrl: 'https://relayer.example',
      accountId: '0xacct',
      signer: new Ed25519Signer(KEY),
      fetch: f,
      sleep: async (ms) => void sleeps.push(ms),
    });
    await expect(adapter.relayerConfig()).resolves.toMatchObject({ network: 'testnet' });
    expect(sleeps).toEqual([500]);
  });
});
