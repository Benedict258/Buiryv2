/** Shared wiring for scripts: an in-process stack on mocks, or on live services from environment variables. */
import { randomBytes } from 'node:crypto';
import {
  FIXTURES_DIR,
  GrpcBackend,
  JsonRpcBackend,
  MockTatum,
  TatumGateway,
  createGatewayFromEnv,
  loadFixtures,
} from '../../packages/chain/src/index.js';
import {
  Ed25519Signer,
  HttpWalrusAdapter,
  MockRelayer,
  type WalrusMemoryAdapter,
} from '../../packages/storage/src/index.js';
import {
  PgDb,
  PgliteDb,
  createStack,
  tatumCallSink,
  type Db,
  type Stack,
} from '../../packages/api/src/index.js';

export interface DemoClock {
  now: () => number;
  advance: (ms: number) => void;
}

export function realClock(): DemoClock {
  return { now: Date.now, advance: () => {} };
}

export function fakeClock(start = Date.now()): DemoClock {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

export interface World {
  mode: 'mock' | 'live';
  stack: Stack;
  adapter: WalrusMemoryAdapter;
  clock: DemoClock;
  /** Mock-only controls (undefined when live). */
  mockRelayer?: MockRelayer;
  mockTatum?: MockTatum;
  gateway?: TatumGateway;
  delegatePublicKey?: string;
  close: () => Promise<void>;
}

const rand = (n: number) => new Uint8Array(randomBytes(n));

/** Everything on mocks: MockRelayer (async jobs, recall lag off) and MockTatum over real gRPC. */
export async function mockWorld(): Promise<World> {
  const clock = fakeClock(Date.parse('2026-10-20T10:00:00Z'));
  const mockRelayer = await MockRelayer.start({ now: clock.now, autoCompleteMs: 0, defaultEpochs: 3 });
  const signer = new Ed25519Signer(randomBytes(32).toString('hex'));
  const adapter = new HttpWalrusAdapter({
    baseUrl: mockRelayer.url,
    accountId: '0xmockaccount',
    signer,
    now: clock.now,
  });
  const mockTatum = await MockTatum.start(
    { apiKey: 'mock' },
    loadFixtures(FIXTURES_DIR).filter((f) => f.network === 'sui:mainnet'),
  );
  const gateway = new TatumGateway({
    backends: {
      'sui:mainnet': [
        new GrpcBackend({
          endpoint: mockTatum.grpcEndpoint,
          apiKey: 'mock',
          insecure: true,
          deadlineMs: 3000,
        }),
        new JsonRpcBackend({ url: mockTatum.jsonrpcUrl, apiKey: 'mock' }),
      ],
    },
    defaultNetwork: 'sui:mainnet',
    now: clock.now,
    sleep: async () => {},
    requestsPerSecond: 1000,
    maxRetries: 0,
  });
  const stack = await createStack({ now: clock.now, random: rand, adapter, gateway, reverifyAfterMs: 1000 });
  gateway.setSink(tatumCallSink(stack.deps));
  return {
    mode: 'mock',
    stack,
    adapter,
    clock,
    mockRelayer,
    mockTatum,
    gateway,
    delegatePublicKey: signer.publicKeyHex,
    close: async () => {
      gateway.close();
      await mockTatum.close();
      await stack.close();
      await mockRelayer.close();
    },
  };
}

/** Live services from env: WALRUS_RELAYER_URL/ACCOUNT_ID/DELEGATE_KEY, TATUM_*; DATABASE_URL optional (else in-memory). */
export async function liveWorld(env: Record<string, string | undefined> = process.env): Promise<World> {
  for (const k of ['WALRUS_RELAYER_URL', 'WALRUS_ACCOUNT_ID', 'WALRUS_DELEGATE_KEY', 'TATUM_API_KEY']) {
    if (!env[k]) throw new Error(`live mode needs ${k} (see .env.example and LOCAL_CHECKS.md)`);
  }
  let db: Db;
  if (env.DATABASE_URL) {
    const pg = PgDb.fromUrl(env.DATABASE_URL);
    await pg.migrate();
    db = pg;
  } else db = await PgliteDb.create();
  const signer = new Ed25519Signer(env.WALRUS_DELEGATE_KEY!);
  const adapter = new HttpWalrusAdapter({
    baseUrl: env.WALRUS_RELAYER_URL!,
    accountId: env.WALRUS_ACCOUNT_ID!,
    signer,
  });
  const clock = realClock();
  const stack = await createStack({ db, now: clock.now, random: rand, adapter });
  const gateway = createGatewayFromEnv(env, { sink: tatumCallSink(stack.deps) });
  stack.deps.gateway = gateway;
  return {
    mode: 'live',
    stack,
    adapter,
    clock,
    gateway,
    delegatePublicKey: signer.publicKeyHex,
    close: async () => (gateway.close(), stack.close()),
  };
}
