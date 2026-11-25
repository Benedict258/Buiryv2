/**
 * Live handoff proof (docs/LIVE_PROOF.md, F1). NOT RUN on either network: it needs the owner's preview server and a
 * tester's own Walrus account (tester A, BYO_A_*). Runs on testnet, or on mainnet with BUIRY_ALLOW_MAINNET=1 and the
 * mainnet profile (Phase 14); the network is saved at prepare and every later step must name the same one. No step requires a chain gateway. Without one, the server's chain check reports
 * unknown (C7 unknown, never a pass) and the relayer returns no recall results (no Seal session, A23), so A30 numbers
 * cannot be recorded; every other step runs. Each step saves into .buiry-local/proof/<run>/.
 *
 *   pnpm tsx scripts/live/handoff-proof.ts prepare <run>           # tokens, prompts for sessions A and B, checklist
 *   pnpm tsx scripts/live/handoff-proof.ts collect <run>           # memories, events, handoffs, briefing, flags
 *   pnpm tsx scripts/live/handoff-proof.ts verify-chain <run> <memoryId>   # C7: one chain verification
 *   pnpm tsx scripts/live/handoff-proof.ts scores <run>            # A30: raw relayer recall numbers
 *   pnpm tsx scripts/live/handoff-proof.ts check <run>             # C1 to C8 from the saved files
 *   pnpm tsx scripts/live/handoff-proof.ts report                  # every run, not the best one
 *
 * Environment (names only): LIVE_REQUIRED_ENV in proof-criteria.ts. BUIRY_PROOF_TOKEN is a person's API token with
 *   read and write, never confirm; scores uses the tester's own account (BYO_A_RELAYER_URL, BYO_A_ACCOUNT_ID,
 *   BYO_A_DELEGATE_KEY) and, when configured, the chain gateway (the chain package's settings, see .env.example).
 * Prints ids, statuses and numbers only: never memory text, keys or tokens.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeMemory, deriveNamespace, relevance } from '../../packages/core/src/index.js';
import { buildWalrusAdapter } from '../../packages/api/src/index.js';
import { createGatewayIfConfigured } from '../../packages/chain/src/index.js';
import {
  LIVE_REQUIRED_ENV,
  PROOF_TYPES,
  evaluateProof,
  runOutcome,
  type ProofMemory,
  type ProofRun,
  preparedNetworkProblem,
} from './proof-criteria.js';
import { healthAllowsWrite } from './etiquette.js';
import { relayerNetworkProblem, requireLiveNetwork } from '../lib/live-guard.js';

/** Set by the network guard for the steps that reach a server, relayer or chain (Phase 14); never defaulted. */
let checkedNetwork: 'testnet' | 'mainnet' | undefined;
const liveNet = (): 'testnet' | 'mainnet' => {
  if (!checkedNetwork) throw new Error('refusing: the network guard has not run for this step');
  return checkedNetwork;
};

const ROOT = '.buiry-local/proof';
const env = process.env as Record<string, string | undefined>;
const [cmd, run, arg] = process.argv.slice(2);
const dir = (r: string) => join(ROOT, r);
const readJson = <T>(r: string, f: string): T => JSON.parse(readFileSync(join(dir(r), f), 'utf8')) as T;
const readText = (r: string, f: string) =>
  existsSync(join(dir(r), f)) ? readFileSync(join(dir(r), f), 'utf8') : '';
const save = (r: string, f: string, v: unknown) =>
  writeFileSync(join(dir(r), f), typeof v === 'string' ? v : JSON.stringify(v, null, 2));

interface Meta {
  runId: string;
  startedAt: string;
  projectId: string;
  tokens: Record<(typeof PROOF_TYPES)[number], string>;
  taskB: string;
  queries: string[];
  /** The Buiry commit the run used. */
  commit: string;
  /** Relayer health read before the run started (F4). */
  relayerHealthAtStart: string;
  /** The network the run was prepared on (Phase 14); absent in runs saved before it, which ran on testnet. */
  network?: 'testnet' | 'mainnet';
}

/** Phase 14: a later step refuses settings that name another network than the run was prepared on. */
function sameNetworkAsPrepared(meta: Meta) {
  const wrong = preparedNetworkProblem(meta.network, liveNet());
  if (wrong) throw new Error(`refusing: ${wrong}`);
}

function need(...names: string[]) {
  const missing = names.filter((n) => !env[n]);
  if (missing.length) {
    console.error(`missing: ${missing.join(', ')} (names only; see docs/LIVE_PROOF.md)`);
    process.exit(64);
  }
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(env.BUIRY_API_URL!.replace(/\/$/, '') + path, {
    method,
    headers: {
      authorization: `Bearer ${env.BUIRY_PROOF_TOKEN}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: T; error?: { code?: string } };
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]}: HTTP ${res.status} ${j.error?.code ?? ''}`);
  return j.data as T;
}

/** The relayer's unsigned /health, as the write etiquette needs it (F4). No credentials involved. */
async function relayerHealth(): Promise<{ reachable: boolean; writeState: 'ok' | 'degraded' | 'paused' }> {
  const url = env.BYO_A_RELAYER_URL;
  if (!url) return { reachable: false, writeState: 'paused' };
  const j = (await fetch(url.replace(/\/$/, '') + '/health', { signal: AbortSignal.timeout(20_000) })
    .then((x) => x.json())
    .catch(() => null)) as { writes?: string } | null;
  if (!j) return { reachable: false, writeState: 'paused' };
  const w = j.writes === 'degraded' || j.writes === 'paused' ? j.writes : 'ok';
  return { reachable: true, writeState: w };
}

async function prepare(r: string) {
  need(...LIVE_REQUIRED_ENV.prepare);
  if (existsSync(dir(r))) throw new Error(`${dir(r)} exists; every run gets a new id and is kept`);
  // F4: do not start a run into a known failure. Sessions write through the server, whose drain also pauses (F1).
  const h = await relayerHealth();
  const healthText = h.reachable ? h.writeState : 'unreachable';
  if (!healthAllowsWrite(h))
    throw new Error(
      `not started: the relayer reports writes ${healthText} at ${new Date().toISOString()}; try later`,
    );
  const commit = (() => {
    try {
      return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch {
      return 'unknown';
    }
  })();
  mkdirSync(dir(r), { recursive: true });
  const tok = (t: string) => `PROOF-${t.toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;
  const meta: Meta = {
    runId: r,
    startedAt: new Date().toISOString(),
    projectId: env.BUIRY_PROOF_PROJECT!,
    tokens: { decision: tok('dec'), constraint: tok('con'), failure: tok('fail') },
    taskB: 'Change how user sessions are stored and add the expiry handling',
    queries: ['session storage', 'session expiry', 'migration failure'],
    commit,
    relayerHealthAtStart: healthText,
    network: liveNet(),
  };
  save(r, 'meta.json', meta);
  save(
    r,
    'prompts-a.md',
    `# Session A (Claude Code), run ${r}

Paste these one at a time. Keep the whole transcript and save it as session-a.txt in this folder.

1. "Call buiry_check first. Then record this decision with buiry_remember, type decision, and include the token ${meta.tokens.decision} in the text: we store user sessions in Postgres, not Redis."
2. "Record a constraint with buiry_remember, type constraint, token ${meta.tokens.constraint}: session rows must never hold the raw refresh token. Attach file evidence for src/session.ts at the current commit."
3. "Record a failure with buiry_remember, type failure, token ${meta.tokens.failure}: running the session migration in one transaction timed out; split it into batches."
4. (A person confirms all three in the dashboard: Memory page, open each, Confirm.)
5. "Write a handoff with buiry_handoff: what you did, what is blocked, what is next."
`,
  );
  save(
    r,
    'prompts-b.md',
    `# Session B (OpenCode), run ${r}

A new OpenCode session in the same repository, connected to the same project. Save the whole transcript as session-b.txt.

1. "Call buiry_check with the task: ${meta.taskB}. Then plan the change." (Do not mention the earlier session or its memories.)
2. Let it work for a few steps; do not correct it.
`,
  );
  save(
    r,
    'checklist.md',
    `# Run ${r} checklist (criteria in docs/LIVE_PROOF.md, fixed before running)

1. Session A: prompts-a.md steps 1 to 3; save session-a.txt.
2. A person confirms the three memories in the dashboard.
3. Session A: step 5 (handoff).
4. Session B: prompts-b.md; save session-b.txt.
5. Conflicting change: commit a change to src/session.ts that breaks the constraint, then run \`buiry verify\` in the repository.
   Save its output as verify-output.txt and its exit code (0 or 1) as verify-exit.txt.
6. \`collect ${r}\`, then \`verify-chain ${r} <id of a memory with transaction evidence>\` (unknown without a chain gateway on the server), then \`scores ${r}\` (records nothing without a chain gateway; it says so).
7. \`check ${r}\`. Record the result whatever it is; then \`report\`.
`,
  );
  console.log(`prepared ${dir(r)}; tokens and prompts saved; started ${meta.startedAt}`);
}

async function collect(r: string) {
  need(...LIVE_REQUIRED_ENV.collect);
  const meta = readJson<Meta>(r, 'meta.json');
  sameNetworkAsPrepared(meta);
  const pid = meta.projectId;
  const project = await api<{ networks: string[] }>('GET', `/v1/projects/${pid}`);
  const account = await api<{ relayerUrl?: string }>('GET', `/v1/projects/${pid}/storage/account`);
  let relayerNetwork: string | null = null;
  if (account.relayerUrl) {
    const conf = (await fetch(account.relayerUrl.replace(/\/$/, '') + '/config')
      .then((x) => x.json())
      .catch(() => ({}))) as { network?: string };
    relayerNetwork = conf.network ?? null;
  }
  const list = await api<{ items: Omit<ProofMemory, 'events'>[] }>(
    'GET',
    `/v1/projects/${pid}/memories?createdAfter=${encodeURIComponent(meta.startedAt)}&limit=100`,
  );
  const memories: ProofMemory[] = [];
  for (const m of list.items) {
    const d = await api<{ events: ProofMemory['events'] }>('GET', `/v1/memories/${m.id}`);
    memories.push({ ...m, events: d.events ?? [] });
  }
  const handoffs = await api<ProofRun['handoffs']>('GET', `/v1/projects/${pid}/handoffs`);
  const briefing = await api<{ items: { memoryId: string }[] }>(
    'GET',
    `/v1/projects/${pid}/briefing?task=${encodeURIComponent(meta.taskB)}`,
  );
  const flags = await api<ProofRun['flags']>('GET', `/v1/projects/${pid}/flags?state=open`);
  save(r, 'collected.json', {
    project: { id: pid, networks: project.networks },
    relayerNetwork,
    memories,
    handoffs,
    briefingItemIds: briefing.items.map((i) => i.memoryId),
    flags,
  });
  console.log(
    `collected: ${memories.length} memories, ${handoffs.length} handoffs, ${flags.length} open flags`,
  );
}

async function verifyChain(r: string, memoryId: string | undefined) {
  need(...LIVE_REQUIRED_ENV.verifyChain);
  if (!memoryId) throw new Error('usage: verify-chain <run> <memoryId>');
  const meta = readJson<Meta>(r, 'meta.json');
  sameNetworkAsPrepared(meta);
  const raw = await api<Record<string, unknown>>('POST', `/v1/projects/${meta.projectId}/verifications`, {
    memoryId,
  });
  const first = (Array.isArray(raw.results) ? raw.results[0] : raw) as { result?: string; network?: string };
  const chain = {
    memoryId,
    result: first?.result ?? 'unknown',
    ...(first?.network ? { network: first.network } : {}),
  };
  save(r, 'chain.json', { ...chain, raw });
  console.log(`chain: ${memoryId} ${chain.result}${chain.network ? ` on ${chain.network}` : ''}`);
}

async function scores(r: string) {
  need(...LIVE_REQUIRED_ENV.scores);
  const meta = readJson<Meta>(r, 'meta.json');
  sameNetworkAsPrepared(meta);
  // The gateway builder's own "configured" check, as byo-live.ts uses. Optional: without it there is no Seal session
  // and the relayer returns no recall results (A23); the step still runs and records that.
  const gateway = createGatewayIfConfigured(env);
  if (!gateway)
    console.log(
      '  no chain gateway configured: no Seal session, so the relayer returns no recall results (A23)',
    );
  const adapter = buildWalrusAdapter(
    {
      relayerUrl: env.BYO_A_RELAYER_URL!,
      accountId: env.BYO_A_ACCOUNT_ID!,
      delegateKey: env.BYO_A_DELEGATE_KEY!,
    },
    gateway,
  );
  const conf = await adapter.relayerConfig();
  const wrongRelayer = relayerNetworkProblem(conf.network, liveNet());
  if (wrongRelayer) throw new Error(`refusing: ${wrongRelayer}`);
  const out: ProofRun['scores'] = [];
  for (const query of meta.queries) {
    const res = await adapter.recall({
      namespace: deriveNamespace(meta.projectId, 'main'),
      query,
      limit: 10,
    });
    out.push({
      query,
      sealSession: !!gateway,
      degraded: !!res.degraded,
      rows: res.results.map((x) => {
        const d = decodeMemory(x.text);
        return {
          memoryId: d.ok ? d.value.header.id : null,
          distance: x.distance ?? null,
          score: x.score ?? null,
          lexical: Math.round(relevance(query, d.ok ? d.value.body : x.text) * 1000) / 1000,
        };
      }),
    });
    if (res.degraded) console.log(`  "${query}": relayer reported degraded (${res.dropped ?? 0} dropped)`);
  }
  save(r, 'scores.json', out);
  for (const q of out)
    for (const row of q.rows)
      console.log(
        `  "${q.query}" ${row.memoryId ?? '(undecodable)'} distance ${row.distance} score ${row.score} lexical ${row.lexical}`,
      );
}

function assemble(r: string): ProofRun {
  const meta = readJson<Meta>(r, 'meta.json');
  const c = readJson<
    Omit<
      ProofRun,
      | 'runId'
      | 'startedAt'
      | 'tokens'
      | 'transcriptA'
      | 'transcriptB'
      | 'verifyOutput'
      | 'verifyExit'
      | 'chain'
      | 'scores'
    >
  >(r, 'collected.json');
  const exit = readText(r, 'verify-exit.txt').trim();
  return {
    runId: meta.runId,
    startedAt: meta.startedAt,
    tokens: meta.tokens,
    ...(meta.network ? { network: meta.network } : {}),
    ...c,
    transcriptA: readText(r, 'session-a.txt'),
    transcriptB: readText(r, 'session-b.txt'),
    verifyOutput: readText(r, 'verify-output.txt'),
    verifyExit: exit === '' ? null : Number(exit),
    chain: existsSync(join(dir(r), 'chain.json')) ? readJson<ProofRun['chain']>(r, 'chain.json') : null,
    scores: existsSync(join(dir(r), 'scores.json')) ? readJson<ProofRun['scores']>(r, 'scores.json') : [],
  };
}

function check(r: string): boolean {
  const c = evaluateProof(assemble(r));
  const outcome = runOutcome(c);
  save(r, 'result.json', { run: r, outcome, criteria: c });
  for (const x of c)
    console.log(`${x.pass ? 'PASS' : x.unknown ? 'UNKNOWN' : 'FAIL'} ${x.id} ${x.what}\n     ${x.detail}`);
  console.log(
    `run ${r}: ${outcome} (C1 to C7 decide; C7 unknown means no chain check could run; C8 is a record for A30)`,
  );
  return outcome !== 'failed';
}

function report() {
  const runs = existsSync(ROOT)
    ? readdirSync(ROOT).filter((d) => existsSync(join(ROOT, d, 'meta.json')))
    : [];
  const lines = [
    '| Run | Started | C1 | C2 | C3 | C4 | C5 | C6 | C7 | C8 (A30) | Result |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of runs.sort()) {
    const meta = readJson<Meta>(r, 'meta.json');
    if (!existsSync(join(dir(r), 'result.json'))) {
      lines.push(`| ${r} | ${meta.startedAt} | not checked |  |  |  |  |  |  |  | incomplete |`);
      continue;
    }
    const res = readJson<{ outcome: string; criteria: { id: string; pass: boolean; unknown?: boolean }[] }>(
      r,
      'result.json',
    );
    const mark = (id: string) => {
      const x = res.criteria.find((y) => y.id === id);
      return x?.pass ? 'pass' : x?.unknown ? 'unknown' : 'FAIL';
    };
    lines.push(
      `| ${r} | ${meta.startedAt} | ${['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8'].map(mark).join(' | ')} | ${res.outcome} |`,
    );
  }
  const text = `# Handoff proof runs (every run, none left out)\n\n${lines.join('\n')}\n`;
  writeFileSync(join(ROOT, 'REPORT.md'), text);
  console.log(text);
}

// Phase 14: the steps that reach a server, relayer or chain run only with named, consistent network settings, on
// testnet or on mainnet with BUIRY_ALLOW_MAINNET=1; the network line is printed first. `check` and `report` read
// saved files only.
if (cmd === 'prepare' || cmd === 'collect' || cmd === 'verify-chain' || cmd === 'scores')
  checkedNetwork = requireLiveNetwork(env, 'handoff-proof', ['BYO_A_RELAYER_URL']);
try {
  if (cmd === 'prepare' && run) await prepare(run);
  else if (cmd === 'collect' && run) await collect(run);
  else if (cmd === 'verify-chain' && run) await verifyChain(run, arg);
  else if (cmd === 'scores' && run) await scores(run);
  else if (cmd === 'check' && run) process.exitCode = check(run) ? 0 : 1;
  else if (cmd === 'report') report();
  else {
    console.error('usage: handoff-proof.ts prepare|collect|verify-chain|scores|check <run> | report');
    process.exitCode = 2;
  }
} catch (e) {
  console.error(`[proof] ${(e as Error).message}`);
  process.exitCode = 1;
}
