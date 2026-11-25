/**
 * Phase 14 B: read-only recall calibration (docs/LIVE_PROOF.md). Recalls only, never writes. Reads account A's namespace
 * of one stored canary run and records how far each labelled query lands from it, so the relevance cutoff can later be
 * calibrated from real distances (A30). Each live run needs the owner's go.
 *
 *   pnpm tsx scripts/with-env.ts testnet -- pnpm tsx scripts/live/recall-calibrate.ts <canaryRun>
 *   BUIRY_ALLOW_MAINNET=1 pnpm tsx scripts/with-env.ts mainnet -- pnpm tsx scripts/live/recall-calibrate.ts <canaryRun>
 *
 * <canaryRun> is the run id of a stored canary (`.buiry-local/proof/canary-<run>.json`, final `done`) on the same
 * network. Guards: the canary's preflight (BYO_A_* present; network named and consistent; mainnet only with
 * BUIRY_ALLOW_MAINNET=1; chain gateway configured for the Seal session), the network line first, and the relayer's
 * /config compared with it. At most 12 queries, one recall each, no retry (the adapter's read retry is off), at least
 * 2 s apart, stop on the first error. Saves to `.buiry-local/proof/calibrate-<canaryRun>-<id>.json`: the network,
 * commit and canary run, then per query only the category label, query id, number of results and raw distances.
 * Never query text, memory text, keys or tokens.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createGatewayIfConfigured, isGatewayConfigured } from '../../packages/chain/src/index.js';
import { buildWalrusAdapter } from '../../packages/api/src/index.js';
import { canaryPreflight } from './canary-lib.js';
import { calibrationQueries, runCalibration } from './calibrate-lib.js';
import { relayerNetworkProblem } from '../lib/live-guard.js';

const DIR = '.buiry-local/proof';
const env = process.env as Record<string, string | undefined>;
const utc = () => new Date().toISOString().slice(0, 19) + 'Z';
const say = (m: string) => console.log(`[calibrate] ${m}`);

// The canary's own preflight, before anything else: account A, network settings, mainnet opt-in, chain gateway.
const pre = canaryPreflight(env, { gatewayConfigured: isGatewayConfigured(env) });
if (!pre.ok) {
  console.error(`[calibrate] ${pre.message}`);
  process.exit(pre.exitCode);
}
say(`${utc()} ${pre.firstLine}`);

const canaryRun = process.argv[2];
if (!canaryRun || !/^[0-9a-f]{6}$/.test(canaryRun)) {
  console.error(
    '[calibrate] usage: recall-calibrate.ts <canaryRun> (the 6-character run id of a stored canary)',
  );
  process.exit(64);
}
const file = `${DIR}/canary-${canaryRun}.json`;
if (!existsSync(file)) {
  console.error(`[calibrate] refused: no saved canary ${canaryRun}`);
  process.exit(64);
}
const saved = JSON.parse(readFileSync(file, 'utf8')) as {
  network?: string;
  final?: string;
  submittedAt?: string;
  blobId?: string;
};
if (saved.network !== pre.network || saved.final !== 'done' || !saved.submittedAt) {
  console.error(
    `[calibrate] refused: canary ${canaryRun} is not a stored canary on ${pre.network} (network ${saved.network ?? 'unknown'}, final ${saved.final ?? 'unknown'})`,
  );
  process.exit(64);
}

const commit = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
})();
const gateway = createGatewayIfConfigured(env);
const adapter = buildWalrusAdapter(
  {
    relayerUrl: env.BYO_A_RELAYER_URL!,
    accountId: env.BYO_A_ACCOUNT_ID!,
    delegateKey: env.BYO_A_DELEGATE_KEY!,
  },
  gateway,
  { readRetries: 0 },
);
const id = randomBytes(3).toString('hex');
try {
  const wrong = relayerNetworkProblem((await adapter.relayerConfig()).network, pre.network);
  if (wrong) {
    console.error(`[calibrate] refused: ${wrong}; no recall made`);
    process.exit(64);
  }
  say(`${utc()} commit ${commit}; canary ${canaryRun}; recalls only, at most 12, 2 s apart, no retry`);
  const out = await runCalibration(adapter, {
    namespace: `buiry.canary.${canaryRun}`,
    queries: calibrationQueries({ run: canaryRun, submittedAt: saved.submittedAt }),
  });
  for (const r of out.rows)
    say(`${r.queryId} ${r.category}: ${r.results} result(s), distances ${JSON.stringify(r.distances)}`);
  if (out.stoppedOnError)
    say(`stopped at ${out.stoppedOnError.queryId}: ${out.stoppedOnError.error} (no retry)`);
  mkdirSync(DIR, { recursive: true });
  writeFileSync(
    `${DIR}/calibrate-${canaryRun}-${id}.json`,
    JSON.stringify(
      {
        id,
        network: pre.network,
        commit,
        canaryRun,
        at: utc(),
        rows: out.rows,
        stoppedOnError: out.stoppedOnError ?? null,
      },
      null,
      2,
    ),
  );
  process.exitCode = out.stoppedOnError ? 1 : 0;
} catch (e) {
  console.error(`[calibrate] failed: ${(e as Error).name}`);
  process.exitCode = 1;
}
