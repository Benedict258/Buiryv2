/**
 * Live check of bring-your-own storage on testnet (LOCAL_CHECKS L-BYO1). Two projects in one workspace: one on the
 * managed account from the profile, one connected to a second Walrus Memory account. One memory each is written and
 * drained; the check passes when each blob is listed only in its own account and recall finds it there.
 *
 *   pnpm tsx scripts/with-env.ts testnet -- pnpm tsx scripts/byo-live.ts
 *
 * Needs, in .env.testnet, besides the usual WALRUS_* and TATUM_* names:
 *   WALRUS_BYO_TEST_RELAYER_URL, WALRUS_BYO_TEST_ACCOUNT_ID, WALRUS_BYO_TEST_DELEGATE_KEY
 * Refuses anything but testnet. Writes two small memories. Prints ids and outcomes only, never a key.
 */
import { randomBytes } from 'node:crypto';
import { createGatewayIfConfigured } from '../packages/chain/src/index.js';
import {
  createAccountDrains,
  createStack,
  setProjectStorage,
  StorageRegistry,
  buildWalrusAdapter,
  type UserPrincipal,
} from '../packages/api/src/index.js';
import { Ed25519Signer, HttpWalrusAdapter, type WalrusMemoryAdapter } from '../packages/storage/src/index.js';

const env = process.env as Record<string, string | undefined>;
const need = [
  'WALRUS_RELAYER_URL',
  'WALRUS_ACCOUNT_ID',
  'WALRUS_DELEGATE_KEY',
  'WALRUS_BYO_TEST_RELAYER_URL',
  'WALRUS_BYO_TEST_ACCOUNT_ID',
  'WALRUS_BYO_TEST_DELEGATE_KEY',
];
const missing = need.filter((k) => !env[k]);
if (missing.length) {
  console.error(`missing: ${missing.join(', ')} (names only; see LOCAL_CHECKS.md L-BYO1)`);
  process.exit(64);
}
if (env.WALRUS_NETWORK !== 'testnet' || (env.TATUM_NETWORK ?? 'testnet') !== 'testnet') {
  console.error(
    'refusing: this check runs on testnet only (WALRUS_NETWORK and TATUM_NETWORK must be testnet)',
  );
  process.exit(64);
}
if (env.WALRUS_BYO_TEST_ACCOUNT_ID === env.WALRUS_ACCOUNT_ID) {
  console.error('refusing: the BYO test account must be a different account from the managed one');
  process.exit(64);
}

const gateway = createGatewayIfConfigured(env);
if (!gateway) {
  console.error('the Tatum gateway is not configured (recall needs it for the Seal session)');
  process.exit(64);
}
const managed = buildWalrusAdapter(
  {
    relayerUrl: env.WALRUS_RELAYER_URL!,
    accountId: env.WALRUS_ACCOUNT_ID!,
    delegateKey: env.WALRUS_DELEGATE_KEY!,
  },
  gateway,
);
const registry = new StorageRegistry({
  managed,
  build: (cfg) => buildWalrusAdapter(cfg, gateway),
  tenancy: { multi: false },
});
const s = await createStack({ adapter: managed, storage: registry, gateway: gateway as never });
s.deps.networks = { sui: 'testnet' };
const run = randomBytes(3).toString('hex');
const ws = await s.newWorkspace(`byo-live-${run}`);
const own = await s.newProject(ws.id, `byo-own-${run}`, { networks: ['sui:testnet'] });
const shared = await s.newProject(ws.id, `byo-managed-${run}`, { networks: ['sui:testnet'] });
const admin: UserPrincipal = {
  kind: 'user',
  workspaceId: ws.id,
  userId: 'usr_byo_live',
  displayName: 'byo-live',
  role: 'owner',
  projectScope: null,
};

const step = (msg: string) => console.log(`[byo-live] ${msg}`);
try {
  // Same live probe as the server: /config network plus a signed read with the key.
  const view = await s.db.tenant(ws.id, (tx) =>
    setProjectStorage(
      s.deps,
      tx,
      admin,
      own.id,
      {
        relayerUrl: env.WALRUS_BYO_TEST_RELAYER_URL!,
        network: 'testnet',
        accountId: env.WALRUS_BYO_TEST_ACCOUNT_ID!,
        delegateKey: env.WALRUS_BYO_TEST_DELEGATE_KEY!,
      },
      {
        probe: async (cfg) => {
          const a = new HttpWalrusAdapter({
            baseUrl: cfg.relayerUrl,
            accountId: cfg.accountId,
            signer: new Ed25519Signer(cfg.delegateKey),
          });
          const conf = await a.relayerConfig();
          await a.list({ limit: 1 });
          return conf;
        },
      },
    ),
  );
  step(
    `connected own account ${view.accountId} on ${view.network}, delegate public key ${view.delegatePublicKey}`,
  );

  const a = await s.newAgent({ workspaceId: ws.id, projectId: own.id, name: 'own', tool: 'claude-code' });
  const b = await s.newAgent({
    workspaceId: ws.id,
    projectId: shared.id,
    name: 'managed',
    tool: 'claude-code',
  });
  const ma = await a.backend.remember({
    text: `BYO live check ${run}: stored in the project's own account.`,
    type: 'fact',
  });
  const mb = await b.backend.remember({
    text: `BYO live check ${run}: stored in the managed account.`,
    type: 'fact',
  });

  const drains = createAccountDrains(s.deps, registry, { pollIntervalMs: 3000 });
  const blob = async (id: string) =>
    (
      await s.db.system((tx) =>
        tx.query<{ walrus_blob_id: string | null }>('select walrus_blob_id from memories where id = $1', [
          id,
        ]),
      )
    ).rows[0]?.walrus_blob_id ?? null;
  const deadline = Date.now() + 4 * 60_000;
  while (Date.now() < deadline && (!(await blob(ma.memoryId)) || !(await blob(mb.memoryId)))) {
    await drains.tick();
    await new Promise((r) => setTimeout(r, 5000));
  }
  const [ba, bb] = [await blob(ma.memoryId), await blob(mb.memoryId)];
  step(
    `own-account blob ${ba ?? 'not stored within 4 minutes'}; managed blob ${bb ?? 'not stored within 4 minutes'}`,
  );
  if (!ba || !bb) throw new Error('writes did not complete in time');

  const ownAdapter = (await registry.byoAdapter(s.deps, own.id))!;
  const listed = async (ad: WalrusMemoryAdapter, ns: string) =>
    (await ad.list({ namespace: ns, limit: 100 })).items.map((i) => i.blobId);
  const ns = async (pid: string) =>
    (
      await s.db.system((tx) =>
        tx.query<{ namespace: string }>(
          `select namespace from branches where project_id = $1 and slug = 'main'`,
          [pid],
        ),
      )
    ).rows[0]!.namespace;
  const [nsOwn, nsShared] = [await ns(own.id), await ns(shared.id)];
  const checks = {
    ownBlobInOwnAccount: (await listed(ownAdapter, nsOwn)).includes(ba),
    ownBlobInManagedAccount: (await listed(managed, nsOwn)).includes(ba),
    managedBlobInManagedAccount: (await listed(managed, nsShared)).includes(bb),
    managedBlobInOwnAccount: (await listed(ownAdapter, nsShared)).includes(bb),
  };
  step(`listing: ${JSON.stringify(checks)}`);

  let recalled = false;
  const rdeadline = Date.now() + 3 * 60_000;
  while (!recalled && Date.now() < rdeadline) {
    const r = await a.backend.recall({ query: `BYO live check ${run}` });
    recalled = JSON.stringify(r).includes(`${run}: stored in the project's own account`);
    if (!recalled) await new Promise((x) => setTimeout(x, 15_000));
  }
  step(`recall from the own account finds its memory: ${recalled}`);
  const pass =
    checks.ownBlobInOwnAccount &&
    !checks.ownBlobInManagedAccount &&
    checks.managedBlobInManagedAccount &&
    !checks.managedBlobInOwnAccount &&
    recalled;
  step(pass ? 'PASS' : 'FAIL');
  process.exitCode = pass ? 0 : 1;
} catch (e) {
  step(`failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  gateway.close();
  await s.close();
}
