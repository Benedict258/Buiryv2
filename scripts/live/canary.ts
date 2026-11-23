/**
 * Write canary (docs/LIVE_PROOF.md): one write on one account (A), a single attempt, followed to a terminal state,
 * then, if stored, a recall of it through the relayer (Seal session when a chain gateway is configured).
 *
 *   pnpm tsx scripts/with-env.ts testnet -- pnpm tsx scripts/live/canary.ts
 *
 * - At most one per hour: refuses if the last canary started less than an hour ago (`.buiry-local/proof/canary-last.json`,
 *   written before the write so a crash still counts).
 * - Refuses while the relayer's /health does not report writes ok. Necessary, not sufficient: on 2026-11-23 health said
 *   ok for hours while every write failed, which is why this canary exists.
 * - Prints and saves job id, UTC times, each status with elapsed seconds, the final state, and for the recall: results
 *   returned, whether the canary was found, its distance and score (A30). Never a key, token or memory text.
 * Exit 0 only when the canary was stored and a recall returned it.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createGatewayIfConfigured } from '../../packages/chain/src/index.js';
import { buildWalrusAdapter } from '../../packages/api/src/index.js';
import { LIVE_REQUIRED_ENV } from './proof-criteria.js';
import { canaryAllowed } from './canary-lib.js';
import { healthAllowsWrite } from './etiquette.js';

const env = process.env as Record<string, string | undefined>;
const DIR = '.buiry-local/proof';
const LAST = `${DIR}/canary-last.json`;
const utc = () => new Date().toISOString().slice(0, 19) + 'Z';
const say = (s: string) => console.log(`[canary] ${s}`);

const missing = LIVE_REQUIRED_ENV.canary.filter((k) => !env[k]);
if (missing.length) {
  console.error(`missing: ${missing.join(', ')} (names only; see docs/LIVE_PROOF.md)`);
  process.exit(64);
}
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
const result: Record<string, unknown> = { run, commit, account: 'A' };
try {
  const conf = await adapter.relayerConfig();
  if (conf.network !== 'testnet') throw new Error(`the relayer serves ${conf.network}, not testnet`);
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
    const st = await adapter.getJob(jobId).catch((e: Error) => ({ state: `poll error ${e.name}` }) as const);
    if (st.state !== lastState) {
      const row = { status: st.state, elapsedSec: Math.round((Date.now() - t0) / 1000), at: utc() };
      statuses.push(row);
      say(`${row.at} job ${jobId} status ${row.status} +${row.elapsedSec}s`);
      lastState = st.state;
    }
    if (st.state === 'done' || st.state === 'failed') {
      final = st.state;
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
        .catch((e: Error) => ({ error: e.name }));
      if ('error' in r) {
        say(`${utc()} recall ${i + 1}: failed (${r.error})`);
        continue;
      }
      const hit = r.results.find((x) => x.text === text);
      found = !!hit;
      result.recall = {
        attempt: i + 1,
        results: r.results.length,
        degraded: !!r.degraded,
        found,
        ...(hit ? { distance: hit.distance ?? null, score: hit.score ?? null } : {}),
      };
      say(`${utc()} recall ${i + 1}: ${JSON.stringify(result.recall)}`);
    }
    result.recallFound = found;
  }
  result.pass = final === 'done' && result.recallFound === true;
  say(result.pass ? 'PASS: stored and recalled' : 'FAIL');
  process.exitCode = result.pass ? 0 : 1;
} catch (e) {
  result.error = (e as { describe?: () => unknown }).describe?.() ?? { error: (e as Error).name };
  say(`failed: ${JSON.stringify(result.error)}`);
  process.exitCode = 1;
} finally {
  writeFileSync(`${DIR}/canary-${run}.json`, JSON.stringify(result, null, 2));
  gateway?.close();
}
