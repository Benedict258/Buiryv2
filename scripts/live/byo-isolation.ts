/**
 * L-BYO2 (docs/LIVE_PROOF.md, F2): two testers, each with their own testnet Walrus Memory account, stay isolated:
 * tokens, scoped lookups and storage. WRITTEN, NOT RUN: it needs two funded testnet accounts. No chain gateway is
 * needed: writes, signed listing and token checks never touch the chain. With a gateway configured (the chain
 * package's settings, see .env.example) recall also goes through the relayer with a Seal session; without one, recall
 * is served from Buiry's index (A23), which still checks scoped lookups, and the output says so.
 *
 *   pnpm tsx scripts/with-env.ts testnet -- pnpm tsx scripts/live/byo-isolation.ts
 *
 * Preview shape: no shared account. Two workspaces (two testers), one project each, each project connected to its own
 * account. Each agent writes one memory with a run marker; then every crossing is attempted.
 * Environment (names only): LIVE_REQUIRED_ENV.isolation in proof-criteria.ts. Refuses a relayer that is not on testnet
 * and the same account twice. Prints ids and outcomes only; result saved to
 * .buiry-local/proof/byo-isolation-<run>.json.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { BuiryError } from '../../packages/core/src/index.js';
import { createGatewayIfConfigured } from '../../packages/chain/src/index.js';
import {
  buildWalrusAdapter,
  createAccountDrains,
  createStack,
  setProjectStorage,
  StorageRegistry,
  type UserPrincipal,
} from '../../packages/api/src/index.js';
import {
  Ed25519Signer,
  HttpWalrusAdapter,
  type WalrusMemoryAdapter,
} from '../../packages/storage/src/index.js';
import { LIVE_REQUIRED_ENV, evaluateIsolation, type IsolationObservation } from './proof-criteria.js';
import { runSequentialWrites } from './etiquette.js';

const env = process.env as Record<string, string | undefined>;
const missing = LIVE_REQUIRED_ENV.isolation.filter((k) => !env[k]);
if (missing.length) {
  console.error(`missing: ${missing.join(', ')} (names only; see docs/LIVE_PROOF.md, F2)`);
  process.exit(64);
}
if (env.BYO_A_ACCOUNT_ID === env.BYO_B_ACCOUNT_ID) {
  console.error('refusing: the two accounts must be different accounts');
  process.exit(64);
}
// Optional: the gateway builder's own "configured" check, as byo-live.ts uses. Without it recall is served from
// Buiry's index (no Seal session, A23); nothing else in this check needs the chain.
const gateway = createGatewayIfConfigured(env);

const registry = new StorageRegistry({
  build: (cfg) => buildWalrusAdapter(cfg, gateway),
  tenancy: { multi: false },
});
const s = await createStack({ storage: registry, ...(gateway ? { gateway: gateway as never } : {}) });
s.deps.networks = { sui: 'testnet' };
const run = randomBytes(3).toString('hex');
const step = (msg: string) => console.log(`[byo-isolation] ${msg}`);
const probe = async (cfg: { relayerUrl: string; accountId: string; delegateKey: string }) => {
  const a = new HttpWalrusAdapter({
    baseUrl: cfg.relayerUrl,
    accountId: cfg.accountId,
    signer: new Ed25519Signer(cfg.delegateKey),
  });
  const conf = await a.relayerConfig();
  if (conf.network !== 'testnet') throw new Error(`relayer serves ${conf.network}, not testnet`);
  await a.list({ limit: 1 });
  return conf;
};

async function tester(side: 'A' | 'B') {
  const ws = await s.newWorkspace(`byo-isolation-${side}-${run}`);
  const prj = await s.newProject(ws.id, `iso-${side}-${run}`, { networks: ['sui:testnet'] });
  const admin: UserPrincipal = {
    kind: 'user',
    workspaceId: ws.id,
    userId: `usr_iso_${side}`,
    displayName: `tester ${side}`,
    role: 'owner',
    projectScope: null,
  };
  const cfg = {
    relayerUrl: env[`BYO_${side}_RELAYER_URL`]!,
    network: 'testnet' as const,
    accountId: env[`BYO_${side}_ACCOUNT_ID`]!,
    delegateKey: env[`BYO_${side}_DELEGATE_KEY`]!,
  };
  const view = await s.db.tenant(ws.id, (tx) => setProjectStorage(s.deps, tx, admin, prj.id, cfg, { probe }));
  step(`tester ${side}: own account ${view.accountId}, delegate public key ${view.delegatePublicKey}`);
  const agent = await s.newAgent({
    workspaceId: ws.id,
    projectId: prj.id,
    name: `iso-${side}`,
    tool: 'claude-code',
  });
  const marker = `ISO-${side}-${run}`;
  const side_ = { ws, prj, agent, marker, memoryId: '' };
  // Written later, one account at a time, through the write etiquette (F4).
  const write = async () => {
    const m = await agent.backend.remember({
      text: `Isolation check ${marker}: belongs only to tester ${side}.`,
      type: 'fact',
    });
    side_.memoryId = m.memoryId;
    return m.memoryId;
  };
  return { side: side_, write };
}

/** True when the call was refused (a BuiryError) or returned nothing carrying the other side's marker. */
async function refused(fn: () => Promise<unknown>, marker: string): Promise<boolean> {
  try {
    const r = await fn();
    return !JSON.stringify(r ?? '').includes(marker);
  } catch (e) {
    return e instanceof BuiryError;
  }
}

const commit = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
})();
const utc = () => new Date().toISOString().slice(0, 19) + 'Z';

try {
  step(`commit ${commit}`);
  const tA = await tester('A');
  const tB = await tester('B');
  const A = tA.side;
  const B = tB.side;
  // The drain's own retry policy applies (F1): at least 10 minutes after a failure, doubling, and paused while degraded.
  const drains = createAccountDrains(s.deps, registry, { pollIntervalMs: 15_000 });
  const startedAt = new Map<string, { label: string; at: number }>();
  // Job ids and every status change, with UTC time and seconds since that account's write started. Content-free.
  s.deps.eventLog = (line) => {
    const j = JSON.parse(line) as {
      event?: string;
      memory?: string;
      relayerJob?: string;
      status?: string;
      attempt?: number;
      reason?: string;
    };
    if (j.event !== 'write_job' || !j.memory) return;
    const st = startedAt.get(j.memory);
    step(
      `${utc()} account ${st?.label ?? '?'} job ${j.relayerJob ?? '-'} status ${j.status} attempt ${j.attempt} +${st ? Math.round((Date.now() - st.at) / 1000) : '?'}s${j.reason ? ` (${j.reason})` : ''}`,
    );
  };
  const state = async (id: string) =>
    (
      await s.db.system((tx) =>
        tx.query<{ walrus_blob_id: string | null; write_state: string }>(
          'select walrus_blob_id, write_state from memories where id = $1',
          [id],
        ),
      )
    ).rows[0];
  const adapterFor = (side: 'A' | 'B') =>
    buildWalrusAdapter(
      {
        relayerUrl: env[`BYO_${side}_RELAYER_URL`]!,
        accountId: env[`BYO_${side}_ACCOUNT_ID`]!,
        delegateKey: env[`BYO_${side}_DELEGATE_KEY`]!,
      },
      gateway,
    );
  const writes = await runSequentialWrites(
    (['A', 'B'] as const).map((label) => ({
      label,
      health: async () => {
        const h = await adapterFor(label)
          .health()
          .catch(() => ({ reachable: false, writeState: 'paused' as const }));
        step(`${utc()} account ${label} health before write: ${h.reachable ? h.writeState : 'unreachable'}`);
        return h;
      },
      write: async () => {
        const id = await (label === 'A' ? tA : tB).write();
        startedAt.set(id, { label, at: Date.now() });
        step(`${utc()} account ${label} write accepted: memory ${id}`);
        return id;
      },
    })),
    {
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      tick: async () => void (await drains.tick()),
      terminal: async (id) => {
        const r = await state(id);
        return r?.write_state === 'stored' ? 'stored' : r?.write_state === 'failed' ? 'dead' : null;
      },
    },
  );
  for (const a of writes.accounts) step(`account ${a.label}: ${a.final}`);
  if (writes.outcome === 'skipped_degraded') {
    step(
      'SKIPPED: the relayer did not report writes ok before a write; this run is not counted as pass or fail',
    );
    mkdirSync('.buiry-local/proof', { recursive: true });
    writeFileSync(
      `.buiry-local/proof/byo-isolation-${run}.json`,
      JSON.stringify({ run, commit, outcome: 'skipped_degraded', writes }, null, 2),
    );
    process.exitCode = 3;
  } else {
    const blobA = (await state(A.memoryId))?.walrus_blob_id ?? null;
    const blobB = (await state(B.memoryId))?.walrus_blob_id ?? null;
    step(`blobs: A ${blobA ?? 'not stored'}, B ${blobB ?? 'not stored'}`);

    const tokenRefused = {
      aReadsB: await refused(() => A.agent.backend.getMemory(B.memoryId), B.marker),
      bReadsA: await refused(() => B.agent.backend.getMemory(A.memoryId), A.marker),
      aWritesB: await refused(() => A.agent.backend.connect({ project: B.prj.id }), B.marker),
      bWritesA: await refused(() => B.agent.backend.connect({ project: A.prj.id }), A.marker),
    };
    // Give the relayer time to index, then search each side for the other's marker (and its own, as a control).
    await new Promise((r) => setTimeout(r, 30_000));
    const recallHas = async (side: typeof A, marker: string) =>
      JSON.stringify(
        await side.agent.backend.recall({ query: `Isolation check ${marker}` }).catch(() => null),
      ).includes(marker);
    const lookupClean = { aFindsB: await recallHas(A, B.marker), bFindsA: await recallHas(B, A.marker) };
    const controls = { aFindsA: await recallHas(A, A.marker), bFindsB: await recallHas(B, B.marker) };
    const recallPath = gateway
      ? 'relayer with a Seal session'
      : 'Buiry index (no chain gateway: no Seal session, A23)';
    step(`recall path: ${recallPath}`);

    const ns = async (pid: string) =>
      (
        await s.db.system((tx) =>
          tx.query<{ namespace: string }>(
            `select namespace from branches where project_id = $1 and slug = 'main'`,
            [pid],
          ),
        )
      ).rows[0]!.namespace;
    const [nsA, nsB] = [await ns(A.prj.id), await ns(B.prj.id)];
    const adA = (await registry.byoAdapter(s.deps, A.prj.id))!;
    const adB = (await registry.byoAdapter(s.deps, B.prj.id))!;
    const listed = async (ad: WalrusMemoryAdapter) =>
      [
        ...(await ad.list({ namespace: nsA, limit: 100 })).items,
        ...(await ad.list({ namespace: nsB, limit: 100 })).items,
      ].map((i) => i.blobId);
    const obs: IsolationObservation = {
      a: { memoryId: A.memoryId, blobId: blobA },
      b: { memoryId: B.memoryId, blobId: blobB },
      tokenRefused,
      lookupClean,
      storage: { aAccountBlobs: await listed(adA), bAccountBlobs: await listed(adB) },
    };
    const criteria = evaluateIsolation(obs);
    for (const c of criteria) step(`${c.pass ? 'PASS' : 'FAIL'} ${c.id} ${c.what}: ${c.detail}`);
    step(
      `controls (each side finds its own memory; not a pass condition, a recall sanity check): ${JSON.stringify(controls)}`,
    );
    const pass = criteria.every((c) => c.pass);
    mkdirSync('.buiry-local/proof', { recursive: true });
    writeFileSync(
      `.buiry-local/proof/byo-isolation-${run}.json`,
      JSON.stringify({ run, commit, pass, recallPath, writes, obs, controls, criteria }, null, 2),
    );
    step(pass ? 'PASS' : 'FAIL');
    process.exitCode = pass ? 0 : 1;
  }
} catch (e) {
  step(`failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  gateway?.close();
  await s.close();
}
