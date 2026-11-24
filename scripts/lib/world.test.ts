import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIXTURES_DIR, MockTatum, loadFixtures } from '../../packages/chain/src/index.js';
import { MockRelayer } from '../../packages/storage/src/index.js';
import { liveWorld } from './world.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

describe('liveWorld refuses mixed networks (B4)', () => {
  it('refuses testnet labels in front of a relayer whose /config says mainnet (the case found live)', async () => {
    const relayer = await MockRelayer.start({}); // its /config reports network mainnet
    const tatum = await MockTatum.start(
      { apiKey: 'k' },
      loadFixtures(FIXTURES_DIR).filter((f) => f.network === 'sui:testnet'),
    );
    closers.push(
      () => relayer.close(),
      () => tatum.close(),
    );
    await expect(
      liveWorld({
        WALRUS_RELAYER_URL: relayer.url,
        WALRUS_ACCOUNT_ID: '0xacct',
        WALRUS_DELEGATE_KEY: '22'.repeat(32), // test-only key
        WALRUS_NETWORK: 'testnet',
        WALRUS_RELAYER_NETWORK: 'testnet', // the mock relayer's host is not a hosted one (Phase 12)
        TATUM_API_KEY: 'k',
        TATUM_NETWORK: 'testnet',
        TATUM_GRPC_ENDPOINT: `http://${tatum.grpcEndpoint}`,
      }),
    ).rejects.toThrow(
      'live mode refused, network mismatch: networks disagree: WALRUS_NETWORK=testnet, TATUM_NETWORK=testnet, relayer /config network=mainnet',
    );
  }, 60_000);

  it('refuses mismatched or mainnet settings before building anything (Phase 12)', async () => {
    // If the guard ever broke, nothing may reach a real service: HTTP is blocked and counted, and the chain endpoint
    // points at a closed local port.
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (u: unknown) => {
      calls.push(String(u));
      throw new Error('network access is blocked in this test');
    });
    closers.push(async () => void vi.unstubAllGlobals());
    const base = {
      WALRUS_ACCOUNT_ID: '0xacct',
      WALRUS_DELEGATE_KEY: '22'.repeat(32), // test-only key
      TATUM_API_KEY: 'k',
      TATUM_GRPC_ENDPOINT: 'http://127.0.0.1:9',
    };
    await expect(
      liveWorld({
        ...base,
        WALRUS_RELAYER_URL: 'https://relayer.memory.walrus.xyz',
        WALRUS_NETWORK: 'testnet',
        TATUM_NETWORK: 'testnet',
      }),
    ).rejects.toThrow(/live mode refused, network settings: networks disagree/);
    await expect(
      liveWorld({
        ...base,
        WALRUS_RELAYER_URL: 'https://relayer.memory.walrus.xyz',
        WALRUS_NETWORK: 'mainnet',
        TATUM_NETWORK: 'mainnet',
      }),
    ).rejects.toThrow(/mainnet is refused without BUIRY_ALLOW_MAINNET=1/);
    expect(calls).toEqual([]);
  });
});
