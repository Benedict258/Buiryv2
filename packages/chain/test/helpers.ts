import { fileURLToPath } from 'node:url';
import { loadFixtures, MockTatum } from '../src/tatum/mock-server.js';
import { GrpcBackend } from '../src/tatum/grpc.js';
import { JsonRpcBackend } from '../src/tatum/jsonrpc.js';
import { TatumGateway, type CallRecord, type GatewayOptions } from '../src/tatum.js';
import ids from '../fixtures/_ids.json' with { type: 'json' };

export { ids };
export const KEY = 'test-key-not-secret';
const FIX = fileURLToPath(new URL('../fixtures', import.meta.url));

export class Clock {
  t = 1_792_000_000_000;
  now = () => this.t;
  sleep = async (ms: number) => {
    this.t += ms;
    this.slept += ms;
  };
  slept = 0;
}

export async function rig(
  o: { grpc?: boolean; jsonrpc?: boolean; gateway?: Partial<GatewayOptions>; apiKey?: string } = {},
) {
  const all = loadFixtures(FIX);
  const mainnet = await MockTatum.start(
    { apiKey: KEY },
    all.filter((f) => f.network === 'sui:mainnet'),
  );
  const testnet = await MockTatum.start(
    { apiKey: KEY },
    all.filter((f) => f.network === 'sui:testnet'),
  );
  const clock = new Clock();
  const records: CallRecord[] = [];
  const key = o.apiKey ?? KEY;
  const mk = (m: MockTatum) => [
    ...(o.grpc === false
      ? []
      : [new GrpcBackend({ endpoint: m.grpcEndpoint, apiKey: key, insecure: true, deadlineMs: 3000 })]),
    ...(o.jsonrpc === false ? [] : [new JsonRpcBackend({ url: m.jsonrpcUrl, apiKey: key })]),
  ];
  const gateway = new TatumGateway({
    backends: { 'sui:mainnet': mk(mainnet), 'sui:testnet': mk(testnet) },
    defaultNetwork: 'sui:mainnet',
    now: clock.now,
    sleep: clock.sleep,
    sink: { record: (r) => void records.push(r) },
    ...o.gateway,
  });
  return {
    gateway,
    mainnet,
    testnet,
    clock,
    records,
    close: async () => {
      gateway.close();
      await mainnet.close();
      await testnet.close();
    },
  };
}
