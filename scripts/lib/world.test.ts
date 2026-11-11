import { afterEach, describe, expect, it } from 'vitest';
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
        TATUM_API_KEY: 'k',
        TATUM_NETWORK: 'testnet',
        TATUM_GRPC_ENDPOINT: `http://${tatum.grpcEndpoint}`,
      }),
    ).rejects.toThrow(
      'live mode refused, network mismatch: networks disagree: WALRUS_NETWORK=testnet, TATUM_NETWORK=testnet, relayer /config network=mainnet',
    );
  }, 60_000);
});
