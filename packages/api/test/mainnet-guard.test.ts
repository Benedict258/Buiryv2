import { BuiryError } from '@buiry/core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRuntime, createStack, runtimeNetworkProblems, validateByo, type Stack } from '../src/index.js';

// Phase 12 B: explicit network, relayer host agreement, mainnet only with BUIRY_ALLOW_MAINNET=1, in normal and
// preview mode. No test here opens a network connection: runtimes are built without a relayer URL or Tatum key, and
// the relayer-host cases stop at the settings check, before any adapter exists.

const MAIN = 'https://relayer.memory.walrus.xyz';
const STAGING = 'https://relayer-staging.memory.walrus.xyz';
const KEY = '22'.repeat(32); // test-only delegate key
const preview = { BUIRY_PREVIEW: '1', BUIRY_MANAGED: 'off' };

// Belt and braces: any HTTP call from this file fails and is counted, so a broken guard can never reach a relayer.
const calls: string[] = [];
beforeAll(() => {
  vi.stubGlobal('fetch', async (u: unknown) => {
    calls.push(String(u));
    throw new Error('network access is blocked in this test');
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  expect(calls).toEqual([]);
});

const open: Stack[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

describe('server startup: the network is explicit', () => {
  it('refuses a relayer URL with no WALRUS_NETWORK, before building anything', async () => {
    await expect(
      buildRuntime({ WALRUS_RELAYER_URL: STAGING, WALRUS_ACCOUNT_ID: '0xabc', WALRUS_DELEGATE_KEY: KEY }),
    ).rejects.toThrow(/refusing to start, network mismatch: .*WALRUS_NETWORK is not set/);
  });

  it('refuses preview mode with no network named', async () => {
    await expect(buildRuntime(preview)).rejects.toThrow(/no network is set/);
  });

  it('refuses a relayer host that disagrees with WALRUS_NETWORK and TATUM_NETWORK', async () => {
    await expect(
      buildRuntime({
        WALRUS_RELAYER_URL: MAIN,
        WALRUS_ACCOUNT_ID: '0xabc',
        WALRUS_DELEGATE_KEY: KEY,
        WALRUS_NETWORK: 'testnet',
        TATUM_NETWORK: 'testnet',
      }),
    ).rejects.toThrow(/networks disagree: .*WALRUS_RELAYER_URL host relayer\.memory\.walrus\.xyz=mainnet/);
  });

  it('refuses an unrecognised relayer host without WALRUS_RELAYER_NETWORK', async () => {
    await expect(
      buildRuntime({
        WALRUS_RELAYER_URL: 'https://relayer.example.test',
        WALRUS_ACCOUNT_ID: '0xabc',
        WALRUS_DELEGATE_KEY: KEY,
        WALRUS_NETWORK: 'testnet',
      }),
    ).rejects.toThrow(/is not a hosted Walrus Memory relayer/);
  });

  it('refuses mainnet without the opt-in, in normal and in preview mode', async () => {
    await expect(buildRuntime({ WALRUS_NETWORK: 'mainnet' })).rejects.toThrow(
      /mainnet is refused without BUIRY_ALLOW_MAINNET=1/,
    );
    await expect(buildRuntime({ ...preview, WALRUS_NETWORK: 'mainnet' })).rejects.toThrow(
      /mainnet is refused without BUIRY_ALLOW_MAINNET=1/,
    );
    expect(
      runtimeNetworkProblems({
        WALRUS_RELAYER_URL: MAIN,
        WALRUS_NETWORK: 'mainnet',
        TATUM_NETWORK: 'mainnet',
      }),
    ).toEqual(['mainnet is refused without BUIRY_ALLOW_MAINNET=1 (an explicit opt-in)']);
  });

  it('passes mainnet with the opt-in and matching values', async () => {
    expect(
      runtimeNetworkProblems({
        BUIRY_ALLOW_MAINNET: '1',
        WALRUS_RELAYER_URL: MAIN,
        WALRUS_NETWORK: 'mainnet',
        TATUM_NETWORK: 'mainnet',
        TATUM_API_KEY: 'not-a-real-key',
      }),
    ).toEqual([]);
    for (const env of [
      { BUIRY_ALLOW_MAINNET: '1', WALRUS_NETWORK: 'mainnet' },
      { ...preview, BUIRY_ALLOW_MAINNET: '1', WALRUS_NETWORK: 'mainnet' },
    ]) {
      const rt = await buildRuntime(env);
      try {
        expect(rt.deps.networks?.sui).toBe('mainnet');
        expect(rt.deps.allowMainnet).toBe(true);
      } finally {
        await rt.close();
      }
    }
  });

  it('never picks mainnet when nothing names a network', async () => {
    const rt = await buildRuntime({});
    try {
      expect(rt.deps.networks?.sui).toBeUndefined();
      expect(rt.deps.allowMainnet).toBeFalsy();
    } finally {
      await rt.close();
    }
    // The Tatum key alone (a gateway with no network) is refused rather than read as mainnet.
    expect(runtimeNetworkProblems({ TATUM_API_KEY: 'not-a-real-key' }).join('\n')).toMatch(
      /TATUM_NETWORK is not set/,
    );
  });
});

describe('own storage accounts: mainnet needs the opt-in too', () => {
  const input = (network: 'mainnet' | 'testnet', relayerUrl = 'https://relayer.example.test') => ({
    relayerUrl,
    network,
    accountId: '0xb10',
    delegateKey: KEY,
  });
  const opts = (network: string) => ({
    resolve: async () => ['93.184.216.34'],
    probe: async () => ({ network }),
  });
  const code = (p: Promise<unknown>) =>
    p.then(
      () => 'ok',
      (e) => (e instanceof BuiryError ? `${e.code}: ${e.message}` : `other: ${(e as Error).message}`),
    );

  it('refuses a mainnet account without BUIRY_ALLOW_MAINNET=1, and accepts it with the opt-in', async () => {
    const s = await createStack();
    open.push(s);
    expect(await code(validateByo(s.deps, input('mainnet'), opts('mainnet')))).toMatch(
      /^invalid_input: .*mainnet .*BUIRY_ALLOW_MAINNET=1/,
    );
    s.deps.allowMainnet = true;
    expect(await code(validateByo(s.deps, input('mainnet'), opts('mainnet')))).toBe('ok');
  });

  it('refuses a hosted relayer URL whose network is not the one stated, before any lookup', async () => {
    const s = await createStack();
    open.push(s);
    s.deps.allowMainnet = true;
    let looked = false;
    const r = await code(
      validateByo(s.deps, input('testnet', MAIN), {
        resolve: async () => ((looked = true), ['93.184.216.34']),
        probe: async () => ({ network: 'testnet' }),
      }),
    );
    expect(r).toMatch(/^invalid_input: .*relayer\.memory\.walrus\.xyz serves mainnet, not testnet/);
    expect(looked).toBe(false);
    expect(await code(validateByo(s.deps, input('testnet', STAGING), opts('testnet')))).toBe('ok');
  });
});
