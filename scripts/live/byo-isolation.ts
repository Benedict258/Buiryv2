/**
 * L-BYO2 (docs/LIVE_PROOF.md, F2): two testers, each with their own Walrus Memory account, stay isolated: tokens,
 * scoped lookups and storage. Runs on testnet, or on mainnet with BUIRY_ALLOW_MAINNET=1 and the mainnet profile
 * (Phase 14). Not yet passed on either network; each live run needs the owner's go. No chain gateway is
 * needed: writes, signed listing and token checks never touch the chain. With a gateway configured (the chain
 * package's settings, see .env.example) recall also goes through the relayer with a Seal session; without one, recall
 * is served from Buiry's index (A23), which still checks scoped lookups, and the output says so.
 *
 *   pnpm tsx scripts/with-env.ts testnet -- pnpm tsx scripts/live/byo-isolation.ts
 *   BUIRY_ALLOW_MAINNET=1 pnpm tsx scripts/with-env.ts mainnet -- pnpm tsx scripts/live/byo-isolation.ts
 *
 * Preview shape: no shared account. Two workspaces (two testers), one project each, each project connected to its own
 * account. Each agent writes one memory with a run marker; then every crossing is attempted.
 * Environment (names only): BYO_A_* and BYO_B_* (LIVE_REQUIRED_ENV.isolation). Refuses a missing name, the same account
 * id, the same delegate key or the same owner wallet twice, and a relayer whose /config names another network. Prints ids and outcomes only; result saved to
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
  StorageRegistry,
} from '../../packages/api/src/index.js';
import {
  Ed25519Signer,
  HttpWalrusAdapter,
  type WalrusMemoryAdapter,
} from '../../packages/storage/src/index.js';
import { evaluateIsolation, type IsolationObservation } from './proof-criteria.js';
import { ISOLATION_DRAIN_OPTIONS, TERMINAL_WAIT_MS, runSequentialWrites, storedWithin } from './etiquette.js';
import {
  relayerNetworkProblem,
  requireLiveNetwork,
  sameWalletProblem,
  twoAccountProblems,
} from '../lib/live-guard.js';
import { ScriptRefusal, errorText } from '../lib/errors.js';
import { applyLiveNetwork, setUpTester } from '../lib/own-account-setup.js';
import { gatedWrites, healthText, waitForHealthyRelayers, writeEventLine } from './health-gate.js';

const env = process.env as Record<string, string | undefined>;
// Phase 14 A: both accounts present and different (names only), then the network guard; the network line is the first
// output, before any adapter, gateway or connection. Mainnet needs BUIRY_ALLOW_MAINNET=1.
const accountProblems = twoAccountProblems(env);
if (accountProblems.length) {
  console.error(`[byo-isolation] refused: ${accountProblems.join('; ')} (see docs/LIVE_PROOF.md, F2)`);
  process.exit(64);
}
const network = requireLiveNetwork(env, 'byo-isolation', ['BYO_A_RELAYER_URL', 'BYO_B_RELAYER_URL']);
// Optional: the gateway builder's own "configured" check, as byo-live.ts uses. Without it recall is served from
// Buiry's index (no Seal session, A23); nothing else in this check needs the chain.
const gateway = createGatewayIfConfigured(env);

const registry = new StorageRegistry({
  build: (cfg) => buildWalrusAdapter(cfg, gateway),
  tenancy: { multi: false },
});
const s = await createStack({ storage: registry, ...(gateway ? { gateway: gateway as never } : {}) });
// Phase 14c: the stack's network and mainnet opt-in from the setting the guard already checked (as server.ts does).
applyLiveNetwork(s.deps, network, env);
const run = randomBytes(3).toString('hex');
const step = (msg: string) => console.log(`[byo-isolation] ${msg}`);
const probe = async (cfg: { relayerUrl: string; accountId: string; delegateKey: string }) => {
  const a = new HttpWalrusAdapter({
    baseUrl: cfg.relayerUrl,
    accountId: cfg.accountId,
    signer: new Ed25519Signer(cfg.delegateKey),
  });
  const conf = await a.relayerConfig();
  const wrong = relayerNetworkProblem(conf.network, network);
  if (wrong) throw new ScriptRefusal(wrong);
  await a.list({ limit: 1 });
  return conf;
};

/**
 * Phase 14 A, before any write: each account's relayer serves the checked network, and the two accounts have different
 * owner wallets (read-only `/config` and `POST /api/stats`). Exits 64 on a mismatch.
 */
async function accountsPreflight() {
  const owners: string[] = [];
  for (const side of ['A', 'B'] as const) {
    const a = new HttpWalrusAdapter({
      baseUrl: env[`BYO_${side}_RELAYER_URL`]!,
      accountId: env[`BYO_${side}_ACCOUNT_ID`]!,
      signer: new Ed25519Signer(env[`BYO_${side}_DELEGATE_KEY`]!),
    });
    const wrong = relayerNetworkProblem((await a.relayerConfig()).network, network);
    if (wrong) {
      console.error(`[byo-isolation] refused: account ${side}: ${wrong}; no write made`);
      process.exit(64);
    }
    owners.push(await a.ownerAddress());
  }
  const same = sameWalletProblem(owners[0]!, owners[1]!);
  if (same) {
    console.error(`[byo-isolation] refused: ${same}; no write made`);
    process.exit(64);
  }
  step(`accounts A and B: relayers serve ${network}; different owner wallets`);
}

async function tester(side: 'A' | 'B') {
  // Phase 14c: the same setup the behaviour tests run (scripts/lib/own-account-setup.ts).
  const { ws, prj, view } = await setUpTester(s, { side, run, network, env, probe });
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
  await accountsPreflight();
  const tA = await tester('A');
  const tB = await tester('B');
  const A = tA.side;
  const B = tB.side;
  // F6: exactly one attempt per account; a failed attempt is final for the run, so nothing retries in the background
  // into the next account's phase. (Retry behaviour is the drain's own, tested separately.)
  const drains = createAccountDrains(s.deps, registry, ISOLATION_DRAIN_OPTIONS);
  const startedAt = new Map<string, { label: string; at: number }>();
  // Job ids and every status change, with UTC time and seconds since that account's write started. Content-free.
  // Phase 14d: failures print their error fields through errorText (class, kind, status, cause), never the reason text.
  s.deps.eventLog = (line) => {
    const memory = (() => {
      try {
        return (JSON.parse(line) as { memory?: unknown }).memory;
      } catch {
        return undefined;
      }
    })();
    const st = typeof memory === 'string' ? startedAt.get(memory) : undefined;
    const out = writeEventLine(line, {
      label: st?.label ?? '?',
      elapsedSec: st ? Math.round((Date.now() - st.at) / 1000) : '?',
      at: utc(),
    });
    if (out) step(out);
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
  // Phase 14d: both relayers healthy on two consecutive read-only polls (at most 10, 60 s apart) before the first
  // write; otherwise the run stops here with no write queued or sent.
  const gated = await gatedWrites(
    () =>
      waitForHealthyRelayers(
        (['A', 'B'] as const).map((label) => ({ label, health: () => adapterFor(label).health() })),
        { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), say: (l) => step(`${utc()} ${l}`) },
      ),
    () =>
      runSequentialWrites(
        (['A', 'B'] as const).map((label) => ({
          label,
          health: async () => {
            const h = await adapterFor(label)
              .health()
              .catch(() => ({ reachable: false, writeState: 'paused' as const }));
            step(`${utc()} account ${label} health before write: ${healthText(h)}`);
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
        // Wait for the single attempt to reach a terminal state; I1 is still scored at the fixed 4 minutes below.
        { deadlineMs: TERMINAL_WAIT_MS, pollMs: 15_000 },
      ),
  );
  if (!gated.result) {
    if (!gated.gate.ok) step(`NOT STARTED: ${gated.gate.reason}`);
    mkdirSync('.buiry-local/proof', { recursive: true });
    writeFileSync(
      `.buiry-local/proof/byo-isolation-${run}.json`,
      JSON.stringify(
        {
          run,
          commit,
          network,
          outcome: 'not_started_unhealthy',
          healthPolls: gated.gate.history,
          writes: 0,
        },
        null,
        2,
      ),
    );
    process.exitCode = 3;
  } else {
    const writes = gated.result;
    for (const a of writes.accounts) step(`account ${a.label}: ${a.final}`);
    if (writes.outcome === 'skipped_degraded') {
      step(
        'SKIPPED: the relayer did not report writes ok before a write; this run is not counted as pass or fail',
      );
      mkdirSync('.buiry-local/proof', { recursive: true });
      writeFileSync(
        `.buiry-local/proof/byo-isolation-${run}.json`,
        JSON.stringify({ run, commit, network, outcome: 'skipped_degraded', writes }, null, 2),
      );
      process.exitCode = 3;
    } else {
      // I1 at the fixed 4-minute window (criteria unchanged): a blob counts only if it was stored within 4 minutes.
      const within = (label: 'A' | 'B') => storedWithin(writes.accounts.find((a) => a.label === label)!);
      const storedA = (await state(A.memoryId))?.walrus_blob_id ?? null;
      const storedB = (await state(B.memoryId))?.walrus_blob_id ?? null;
      const blobA = within('A') ? storedA : null;
      const blobB = within('B') ? storedB : null;
      step(
        `blobs: A ${storedA ?? 'not stored'}${storedA && !blobA ? ' (stored after the 4-minute window: not counted for I1)' : ''}, B ${storedB ?? 'not stored'}${storedB && !blobB ? ' (stored after the 4-minute window: not counted for I1)' : ''}`,
      );

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
        JSON.stringify({ run, commit, network, pass, recallPath, writes, obs, controls, criteria }, null, 2),
      );
      step(pass ? 'PASS' : 'FAIL');
      process.exitCode = pass ? 0 : 1;
    }
  }
} catch (e) {
  // Phase 14b: class, kind, HTTP status and network cause code only; a script refusal as written.
  step(`failed: ${errorText(e)}`);
  process.exitCode = 1;
} finally {
  gateway?.close();
  await s.close();
}
