/**
 * Write canary (docs/LIVE_PROOF.md): one write on one account (A), a single attempt, followed to a terminal state,
 * then, if stored, a recall of it through the relayer (Seal session when a chain gateway is configured).
 *
 *   pnpm tsx scripts/with-env.ts testnet -- pnpm tsx scripts/live/canary.ts
 *   BUIRY_ALLOW_MAINNET=1 pnpm tsx scripts/with-env.ts mainnet -- pnpm tsx scripts/live/canary.ts   (only on the owner's go)
 *
 * - Refuses unless the network settings are named and consistent (relayer host, WALRUS_NETWORK, TATUM_NETWORK), the
 *   chain gateway is configured, and, on mainnet, BUIRY_ALLOW_MAINNET=1 is set (Phase 12). Prints the network first.
 * - Exactly one write, never retried, on any network.
 * - At most one per hour: refuses if the last canary started less than an hour ago (`.buiry-local/proof/canary-last.json`,
 *   written before the write so a crash still counts).
 * - Refuses while the relayer's /health does not report writes ok. Necessary, not sufficient: on 2026-11-23 health said
 *   ok for hours while every write failed, which is why this canary exists.
 * - Prints and saves job id, UTC times, each status with elapsed seconds, the final state, the blob id from the finished
 *   job, and for the recall: results returned, whether the canary was found, its raw distance (and a score only if the
 *   relayer sent one), and each result's field names and raw distance (Phase 13 C). Never a key, token or memory text.
 * Exit 0 only on PASS: the job completed with a blob id, a recall returned the canary, and its raw distance was
 * recorded. No relayer score is required: the relayer sends one only with scoring_weights, which Buiry omits (A30).
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createGatewayIfConfigured, isGatewayConfigured } from '../../packages/chain/src/index.js';
import { buildWalrusAdapter } from '../../packages/api/src/index.js';
import {
  canaryAllowed,
  canaryPass,
  canaryPreflight,
  canaryRecallRecord,
  type CanaryRecallRecord,
} from './canary-lib.js';
import { ScriptRefusal, errorText } from '../lib/errors.js';
import { relayerNetworkProblem } from '../lib/live-guard.js';
import { healthAllowsWrite } from './etiquette.js';

const env = process.env as Record<string, string | undefined>;
const DIR = '.buiry-local/proof';
const LAST = `${DIR}/canary-last.json`;
const utc = () => new Date().toISOString().slice(0, 19) + 'Z';
const say = (s: string) => console.log(`[canary] ${s}`);

// Phase 12 C: account settings, network settings (named, consistent, mainnet only with BUIRY_ALLOW_MAINNET=1) and the
// chain gateway, before the pacing check and before any adapter exists. The network is the first line printed.
const pre = canaryPreflight(env, { gatewayConfigured: isGatewayConfigured(env) });
if (!pre.ok) {
  console.error(`[canary] ${pre.message}`);
  process.exit(pre.exitCode);
}
say(`${utc()} ${pre.firstLine}`);
mkdirSync(DIR, { recursive: true });
const last = existsSync(LAST)
  ? ((JSON.parse(readFileSync(LAST, 'utf8')) as { at?: string }).at ?? 'unreadable')
  : null;
const allowed = canaryAllowed(last, Date.now());
if (!allowed.ok) {
  say(
    `refused: the last canary started at ${last}; wait about ${allowed.waitMinutes} more minutes (at most one per hour)`,
  );
  process.exit(4);
}

const gateway = createGatewayIfConfigured(env);
const adapter = buildWalrusAdapter(
  {
    relayerUrl: env.BYO_A_RELAYER_URL!,
    accountId: env.BYO_A_ACCOUNT_ID!,
    delegateKey: env.BYO_A_DELEGATE_KEY!,
  },
  gateway,
);
const commit = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
})();
const run = randomBytes(3).toString('hex');
const result: Record<string, unknown> = { run, commit, account: 'A', network: pre.network };
try {
  const conf = await adapter.relayerConfig();
  // Fails closed: any other network, or none, stops the canary before the write (Phase 14b: via relayerNetworkProblem).
  const wrongNetwork = relayerNetworkProblem(conf.network, pre.network);
  if (wrongNetwork) throw new ScriptRefusal(wrongNetwork);
  const h = await adapter.health().catch(() => ({ reachable: false, writeState: 'paused' as const }));
  result.healthBefore = h.reachable ? h.writeState : 'unreachable';
  say(`${utc()} commit ${commit}; relayer health before: ${result.healthBefore as string}`);
  if (!healthAllowsWrite(h)) {
    say('refused: the relayer does not report writes ok; no write made (this does not use the hourly slot)');
    process.exit(3);
  }

  // The hourly slot is taken before the write, so a crash or interruption still counts as a canary.
  writeFileSync(LAST, JSON.stringify({ at: new Date().toISOString(), run }));
  const namespace = `buiry.canary.${run}`;
  const text = `Buiry canary ${run}: a one-line test memory written ${utc()}.`;
  const t0 = Date.now();
  const { jobId } = await adapter.remember(namespace, text);
  result.jobId = jobId;
  result.submittedAt = utc();
  say(`${utc()} submitted: job ${jobId} (single attempt; no retry)`);
  const statuses: { status: string; elapsedSec: number; at: string }[] = [];
  let final: 'done' | 'failed' | 'no terminal state within 15 minutes' =
    'no terminal state within 15 minutes';
  let lastState = '';
  while (Date.now() - t0 < 15 * 60_000) {
    const st = await adapter
      .getJob(jobId)
      .catch((e: unknown) => ({ state: `poll error ${errorText(e)}` }) as const);
    if (st.state !== lastState) {
      const row = { status: st.state, elapsedSec: Math.round((Date.now() - t0) / 1000), at: utc() };
      statuses.push(row);
      say(`${row.at} job ${jobId} status ${row.status} +${row.elapsedSec}s`);
      lastState = st.state;
    }
    if (st.state === 'done' || st.state === 'failed') {
      final = st.state;
      // Phase 13 C: the blob id from the finished job is part of the record and of the pass criteria.
      if (st.state === 'done') {
        result.blobId = st.blobId;
        say(`${utc()} blob id ${st.blobId}`);
      }
      if (st.state === 'failed')
        result.reason = /capacity/i.test(st.error) ? 'capacity limit reported by the relayer' : 'job failed';
      break;
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  result.statuses = statuses;
  result.final = final;
  say(`${utc()} final: ${final}${result.reason ? ` (${result.reason as string})` : ''}`);

  if (final === 'done') {
    // Recall the canary through the relayer: real results, read with the Seal session when a gateway is configured.
    let found = false;
    for (let i = 0; i < 3 && !found; i++) {
      if (i) await new Promise((r) => setTimeout(r, 30_000));
      const r = await adapter
        .recall({ namespace, query: text, limit: 5 })
        .catch((e: unknown) => ({ error: errorText(e) }));
      if ('error' in r) {
        say(`${utc()} recall ${i + 1}: failed (${r.error})`);
        continue;
      }
      // Phase 13 C: field names and raw distances per result, the hit's distance and score; never memory text.
      const rec = canaryRecallRecord(r, text);
      found = rec.found;
      result.recall = { attempt: i + 1, ...rec };
      say(`${utc()} recall ${i + 1}: ${JSON.stringify(result.recall)}`);
    }
    result.recallFound = found;
  }
  // Phase 13: PASS = job done with a blob id, the memory recalled, and its raw distance recorded. No score required.
  result.pass = canaryPass({
    final,
    blobId: result.blobId as string | undefined,
    recall: result.recall as CanaryRecallRecord | undefined,
  });
  say(
    result.pass
      ? 'PASS: job done with a blob id; recalled, raw distance recorded'
      : `FAIL: ${final !== 'done' ? `job ${final}` : !result.blobId ? 'no blob id' : !result.recallFound ? 'not recalled' : 'no distance recorded'}`,
  );
  process.exitCode = result.pass ? 0 : 1;
} catch (e) {
  // Phase 14b: class, kind, HTTP status and network cause code only; never the message, a URL or a value.
  result.error = errorText(e);
  say(`failed: ${errorText(e)}`);
  process.exitCode = 1;
} finally {
  writeFileSync(`${DIR}/canary-${run}.json`, JSON.stringify(result, null, 2));
  gateway?.close();
}
