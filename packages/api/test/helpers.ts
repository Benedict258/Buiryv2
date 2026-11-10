import { randomBytes } from 'node:crypto';
import { FIXTURES_DIR, GrpcBackend, MockTatum, TatumGateway, loadFixtures } from '@buiry/chain';
import { Ed25519Signer, HttpWalrusAdapter, MockRelayer } from '@buiry/storage';
import { createStack, createDrain, type Stack } from '../src/index.js';
import ids from '../../chain/fixtures/_ids.json' with { type: 'json' };

export { ids };
export const KEY = 'test-key-not-secret';

export class Clock {
  t = Date.parse('2026-10-20T10:00:00Z');
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

export async function startGateway(clock: Clock, apiKey = KEY) {
  const all = loadFixtures(FIXTURES_DIR);
  const mainnet = await MockTatum.start(
    { apiKey: KEY },
    all.filter((f) => f.network === 'sui:mainnet'),
  );
  const testnet = await MockTatum.start(
    { apiKey: KEY },
    all.filter((f) => f.network === 'sui:testnet'),
  );
  const mk = (m: MockTatum) => [
    new GrpcBackend({ endpoint: m.grpcEndpoint, apiKey, insecure: true, deadlineMs: 2000 }),
  ];
  const gateway = new TatumGateway({
    backends: { 'sui:mainnet': mk(mainnet), 'sui:testnet': mk(testnet) },
    defaultNetwork: 'sui:mainnet',
    now: clock.now,
    sleep: async () => {},
    requestsPerSecond: 1000,
    maxRetries: 0,
  });
  return {
    gateway,
    mainnet,
    testnet,
    close: async () => {
      gateway.close();
      await mainnet.close();
      await testnet.close();
    },
  };
}

export async function startRelayer(clock: Clock) {
  const mock = await MockRelayer.start({ now: clock.now, autoCompleteMs: 0 });
  const adapter = new HttpWalrusAdapter({
    baseUrl: mock.url,
    accountId: '0xacct',
    signer: new Ed25519Signer('44'.repeat(32)),
    now: clock.now,
  });
  return { mock, adapter };
}

export const rand = (n: number) => new Uint8Array(randomBytes(n));
export type { Stack };
export { createStack, createDrain };
