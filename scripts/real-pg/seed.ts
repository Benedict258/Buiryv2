/**
 * Seeds a throwaway Postgres for the real-Postgres checks (LOCAL_CHECKS L-BAK1 and L-KEY1). It runs the real service
 * layer against DATABASE_URL with a MockRelayer and a MockTatum (both in-process, nothing on the network), and creates:
 * a workspace, a project, memories stored on the mock relayer, a webhook (sealed signing secret) and a second project
 * with its own Walrus account (sealed delegate key). Everything is sealed under BUIRY_SECRET_KEY, which the caller
 * generates as a throwaway value. Prints counts only, never a key, secret or URL.
 *
 *   DATABASE_URL=postgres://postgres:<local-only>@127.0.0.1:55432/buiry_seed \
 *   BUIRY_SECRET_KEY=<throwaway, 32+ characters> pnpm tsx scripts/real-pg/seed.ts
 *
 * Refuses a non-local database host unless BUIRY_SEED_ALLOW_REMOTE=1.
 */
import { randomBytes } from 'node:crypto';
import { FIXTURES_DIR, GrpcBackend, MockTatum, TatumGateway, loadFixtures } from '@buiry/chain';
import { Ed25519Signer, HttpWalrusAdapter, MockRelayer } from '@buiry/storage';
import {
  PgDb,
  createDrain,
  createStack,
  createWebhook,
  setProjectStorage,
  type UserPrincipal,
} from '@buiry/api';
import { assertLocalDatabase } from './local.js';

const url = process.env.DATABASE_URL;
const secretKey = process.env.BUIRY_SECRET_KEY ?? '';
if (!url) throw new Error('set DATABASE_URL');
if (secretKey.length < 32)
  throw new Error('set BUIRY_SECRET_KEY to a throwaway value of 32 or more characters');
assertLocalDatabase(url, process.env);

const db = PgDb.fromUrl(url);
const applied = await db.migrate();
console.log(`[seed] migrations applied: ${applied.length}`);

const relayer = await MockRelayer.start({ autoCompleteMs: 0 });
const ownRelayer = await MockRelayer.start({ autoCompleteMs: 0 });
const tatum = await MockTatum.start({ apiKey: 'seed-not-a-key' }, loadFixtures(FIXTURES_DIR));
const gateway = new TatumGateway({
  backends: {
    'sui:mainnet': [
      new GrpcBackend({ endpoint: tatum.grpcEndpoint, apiKey: 'seed-not-a-key', insecure: true }),
    ],
  },
  defaultNetwork: 'sui:mainnet',
});
const adapter = new HttpWalrusAdapter({
  baseUrl: relayer.url,
  accountId: '0x5eed',
  signer: new Ed25519Signer(randomBytes(32).toString('hex')),
});

try {
  const stack = await createStack({ db, secretKey, adapter, gateway });
  const ws = await stack.newWorkspace('Seed workspace');
  const project = await stack.newProject(ws.id, 'seed-api');
  const agent = await stack.newAgent({
    workspaceId: ws.id,
    projectId: project.id,
    name: 'seed',
    tool: 'claude-code',
    permissions: ['read', 'write'],
  });
  for (const [text, type] of [
    ['Use pnpm workspaces; npm hoisting broke the build.', 'decision'],
    ['Never import from internal/ in app code.', 'constraint'],
    ['Running the migration in one transaction exceeded the gas limit.', 'failure'],
  ] as const)
    await agent.backend.remember({ text, type });
  // The first pass submits; later passes see the mock relayer's finished jobs and record the blob ids.
  const worker = createDrain(stack.deps, adapter, { pollIntervalMs: 0 });
  let drained = await worker.tick();
  for (let i = 0; i < 5 && drained.stored < 3; i++) {
    const next = await worker.tick();
    drained = {
      ...next,
      stored: drained.stored + next.stored,
      submitted: drained.submitted + next.submitted,
    };
  }

  const owner: UserPrincipal = {
    kind: 'user',
    workspaceId: ws.id,
    userId: 'usr_seed',
    displayName: 'Seed owner',
    role: 'owner',
    projectScope: null,
  };
  // A fixed public address for the receiver: no DNS lookup and nothing is sent (deliveries are not run here).
  await db.tenant(ws.id, (tx) =>
    createWebhook(
      stack.deps,
      tx,
      owner,
      { name: 'seed hook', kind: 'generic', url: 'https://hooks.example.test/buiry', events: ['*'] },
      { resolve: async () => ['93.184.216.34'] },
    ),
  );
  const own = await stack.newProject(ws.id, 'seed-own-account', { walrusMode: 'byo' });
  await db.tenant(ws.id, (tx) =>
    setProjectStorage(
      stack.deps,
      tx,
      owner,
      own.id,
      {
        relayerUrl: ownRelayer.url,
        network: 'testnet',
        accountId: '0x0e1d',
        delegateKey: randomBytes(32).toString('hex'),
      },
      { allowPrivate: true }, // the own-account relayer is a local mock
    ),
  );

  const counts = await db.system((tx) =>
    tx.query<{ k: string; n: string }>(
      `select 'workspaces' as k, count(*)::text as n from workspaces
       union all select 'projects', count(*)::text from projects
       union all select 'memories', count(*)::text from memories
       union all select 'stored_memories', count(*)::text from memories where walrus_blob_id is not null
       union all select 'webhooks_sealed', count(*)::text from webhooks
       union all select 'own_accounts_sealed', count(*)::text from project_storage`,
    ),
  );
  console.log(`[seed] write queue: ${JSON.stringify(drained)}`);
  console.log(`[seed] rows: ${counts.rows.map((r) => `${r.k}=${r.n}`).join(' ')}`);
} finally {
  gateway.close();
  await tatum.close();
  await relayer.close();
  await ownRelayer.close();
  await db.close();
}
