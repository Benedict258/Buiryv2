/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Two-agent demo (scripted). Default: all mocks, runnable anywhere. `--live`: real Walrus relayer and Tatum
 * from environment variables (see LOCAL_CHECKS.md). Nothing in the transcript is invented: every line is read
 * back from the running system, and live mode reports what the live services actually returned.
 *
 *   pnpm demo            # mocks
 *   pnpm demo --live     # live services from your machine
 */
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createBuiryMcpServer, startHttpServer } from '../../packages/mcp/src/index.js';
import { createDrain, evidenceReport, queryActivity, type Stack } from '../../packages/api/src/index.js';
import { expiryScan } from '../../packages/worker/src/index.js';
import ids from '../../packages/chain/fixtures/_ids.json' with { type: 'json' };
import { liveWorld, mockWorld, type World } from '../lib/world.js';

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, any>;
  content?: { type: string; text?: string }[];
};

export interface DemoResult {
  mode: 'mock' | 'live';
  firstConnectionOfB: boolean;
  failureShownFirst: boolean;
  failureMemoryId: string;
  deploymentMemoryId: string;
  staleDetected: boolean | 'not-applicable';
  staleFlagShownAtCheck: boolean;
  correctedMemoryId?: string;
  correctedConfidence?: number;
  blobIds: string[];
  expiries: (string | null)[];
  tatumCalls: number;
}

export interface DemoOptions {
  live?: boolean;
  log?: (s: string) => void;
  env?: Record<string, string | undefined>;
  /** Mock only: delay before the mock relayer reports expiry (the live relayers take minutes). */
  mockExpiryLagMs?: number;
}

const text = (r: ToolResult) => r.content?.map((c) => c.text ?? '').join('\n') ?? '';

export async function runDemo(o: DemoOptions = {}): Promise<DemoResult> {
  const log = o.log ?? (() => {});
  const env = o.env ?? process.env;
  const world: World = o.live
    ? await liveWorld(env)
    : await mockWorld(o.mockExpiryLagMs ? { expiryLagMs: o.mockExpiryLagMs } : {});
  const { stack, clock } = world;
  const live = world.mode === 'live';
  const heading = (s: string) => log(`\n== ${s}`);
  const say = (s: string) => log(`   ${s}`);

  // The package and transaction used for the drift story. Live mode needs your own (an upgraded package and a digest).
  const pkg = live ? env.DEMO_PACKAGE_ID : ids.PKG_V3;
  const tx = live ? env.DEMO_TX_DIGEST : ids.D_PUBLISH;
  if (live && (!pkg || !tx))
    throw new Error(
      'live demo needs DEMO_PACKAGE_ID (a package that has since been upgraded) and DEMO_TX_DIGEST (a successful publish/upgrade transaction)',
    );
  // Live: the agreed deployment network (the world refuses to start on a mismatch); never a silent Mainnet default.
  const agreed = world.stack.deps.networks?.sui;
  const network = live ? (env.DEMO_NETWORK ?? (agreed ? `sui:${agreed}` : undefined)) : 'sui:mainnet';
  if (!network)
    throw new Error(
      'live demo needs DEMO_NETWORK (for example sui:testnet), or WALRUS_NETWORK / TATUM_NETWORK set',
    );

  heading(`Setup (${world.mode}): workspace, project, two agents with different tool identities`);
  const ws = await stack.newWorkspace('Northwind Labs');
  const prj = await stack.newProject(ws.id, 'orbit-api', { networks: [network] });
  const a = await stack.newAgent({
    workspaceId: ws.id,
    projectId: prj.id,
    name: 'claude-code',
    tool: 'claude-code',
  });
  const b = await stack.newAgent({
    workspaceId: ws.id,
    projectId: prj.id,
    name: 'opencode',
    tool: 'opencode',
  });
  say(`project ${prj.id}`);
  say(`agent A: ${a.slug} (Claude Code)    agent B: ${b.slug} (OpenCode)`);

  const call = async (c: Client, name: string, args: Record<string, unknown> = {}) =>
    (await c.callTool({ name, arguments: args })) as ToolResult;
  const drain = createDrain(stack.deps, world.adapter, { pollIntervalMs: 500 });
  const settle = async (label: string) => {
    for (let i = 0; i < 40; i++) {
      await drain.tick();
      const s = await stack.db.system((tx2) =>
        tx2.query<{ n: string }>(`select count(*) as n from write_jobs where state not in ('stored','dead')`),
      );
      if (Number(s.rows[0]!.n) === 0) break;
      if (live) await new Promise((r) => setTimeout(r, 1500));
      else clock.advance(3000);
    }
    say(`${label}: storage queue drained`);
  };

  // ---------------- Session 1: agent A hits a trap and records it ----------------
  heading('Session 1 (agent A, in-memory MCP): connect, check, hit a failure, record it');
  const serverA = createBuiryMcpServer({ backend: () => stack.backendFor(a.token) });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await serverA.connect(st);
  const ca = new Client({ name: 'demo-agent-a', version: '1.0.0' });
  await ca.connect(ct);
  const conA = await call(ca, 'buiry_connect', { project: prj.id, client: 'claude-code' });
  say(
    `buiry_connect -> firstConnection=${conA.structuredContent!.firstConnection}, ${conA.structuredContent!.counts.total} memories`,
  );
  await call(ca, 'buiry_check', { task: 'migrate the users table to the new schema' });
  say('buiry_check -> empty-project briefing');
  say('Agent A tries the migration in a single transaction and it exceeds the gas limit...');
  const fail = await call(ca, 'buiry_remember', {
    text: 'Migrating the users table in a single transaction exceeded the gas limit; split it into batches of 200 rows.',
    type: 'failure',
    evidence: [{ kind: 'test', name: 'migrate-users-single-tx', result: 'fail' }],
  });
  const failureMemoryId = fail.structuredContent!.memoryId as string;
  say(
    `buiry_remember(failure) -> ${failureMemoryId} (${fail.structuredContent!.status}, ${fail.structuredContent!.state})`,
  );
  await call(ca, 'buiry_remember', {
    text: 'Never import from internal/ in app code; use the public barrel files.',
    type: 'constraint',
  });
  const dep = await call(ca, 'buiry_remember', {
    // Live mode does not know the cited version, so it does not claim one.
    text: `Registry package deployed on ${network.replace('sui:', '')} at ${pkg}${live ? '' : ', version 3'}.`,
    type: 'deployment',
    evidence: [{ kind: 'package', id: pkg, network }],
  });
  const deploymentMemoryId = dep.structuredContent!.memoryId as string;
  say(`buiry_remember(deployment) -> ${deploymentMemoryId}`);
  await call(ca, 'buiry_handoff', {
    done: ['investigated the migration failure'],
    blocked: [],
    next: ['write the batched migration'],
    reliedOn: [failureMemoryId],
  });
  say('buiry_handoff -> recorded');
  await ca.close();
  await settle('after session 1');

  // ---------------- Session 2: agent B, different tool, is shown the failure first ----------------
  heading('Session 2 (agent B, Streamable HTTP, a different tool identity): onboarding briefing');
  const http = await startHttpServer({ authenticate: (token, sid) => stack.backendFor(token, sid) });
  const cb = new Client({ name: 'demo-agent-b', version: '1.0.0' });
  await cb.connect(
    new StreamableHTTPClientTransport(new URL(http.url), {
      requestInit: { headers: { authorization: `Bearer ${b.token}` } },
    }),
  );
  const conB = await call(cb, 'buiry_connect', { project: prj.id, client: 'opencode' });
  const sc = conB.structuredContent!;
  say(
    `buiry_connect -> firstConnection=${sc.firstConnection}; found ${sc.counts.total} memories, last written by ${sc.lastActivity?.agent}`,
  );
  const chk = await call(cb, 'buiry_check', { task: 'write a migration for the users table' });
  const md = text(chk);
  const failureShownFirst =
    /## Failures to avoid\n\n- \[[^\]]*\] mem_\w+: Migrating the users table in a single transaction/.test(
      md,
    );
  say(`buiry_check -> onboarding briefing; failure shown first: ${failureShownFirst}`);
  log(
    md
      .split('\n')
      .filter((l) => /^(#|- \[|> )/.test(l))
      .slice(0, 14)
      .map((l) => `      | ${l.slice(0, 150)}`)
      .join('\n'),
  );
  const rep = await call(cb, 'buiry_report', { memoryId: failureMemoryId, outcome: 'helped' });
  say(`buiry_report(helped) -> confidence ${rep.structuredContent!.confidence} (agent report, weight 0.5)`);

  // ---------------- Drift: the package was upgraded; the memory goes stale ----------------
  heading('Drift: the cited package was upgraded; Buiry checks the chain through Tatum');
  clock.advance(5000);
  const ver = await call(cb, 'buiry_verify', { memoryId: deploymentMemoryId });
  const vr = ver.structuredContent!.results[0];
  say(`buiry_verify -> ${vr.result}${vr.degraded ? ' (gateway degraded)' : ''}: ${vr.detail}`);
  const staleDetected: DemoResult['staleDetected'] =
    ver.structuredContent!.status === 'stale'
      ? true
      : vr.result === 'pass' && live
        ? 'not-applicable'
        : false;
  say(`memory status is now: ${ver.structuredContent!.status}`);
  const chk2 = await call(cb, 'buiry_check', { task: 'deploy the registry package' });
  const flag = (chk2.structuredContent!.flags as { memoryId: string; kind: string }[]).find(
    (f) => f.memoryId === deploymentMemoryId && f.kind === 'stale',
  );
  const staleFlagShownAtCheck = !!flag;
  say(`buiry_check -> flags the stale deployment to the agent: ${staleFlagShownAtCheck}`);

  heading('Correction: agent B re-records the deployment from the transaction digest');
  const fixed = await call(cb, 'buiry_remember', {
    text: `Registry package redeployed after the upgrade (see transaction ${tx}).`,
    type: 'deployment',
    evidence: [{ kind: 'tx', digest: tx, network }],
    relation: { kind: 'supersedes', memoryId: deploymentMemoryId },
  });
  const correctedMemoryId = fixed.structuredContent?.memoryId as string | undefined;
  let correctedConfidence: number | undefined;
  if (correctedMemoryId) {
    const d = await cb.callTool({
      name: 'buiry_recall',
      arguments: { query: 'registry package redeployed', type: 'deployment' },
    });
    const hit = (
      (d as ToolResult).structuredContent!.results as {
        memoryId: string;
        confidence: number;
        evidence: { kind: string }[];
      }[]
    ).find((r) => r.memoryId === correctedMemoryId);
    correctedConfidence = hit?.confidence;
    say(
      `buiry_remember(deployment, tx evidence, supersedes old) -> ${correctedMemoryId}, confidence ${hit?.confidence} with ${hit?.evidence.length} evidence items (identifiers extracted from the transaction)`,
    );
  }
  await cb.close();
  await http.close();
  await settle('after correction');

  // ---------------- What the dashboard shows ----------------
  heading('Evidence of what happened (the dashboard reads the same data)');
  const admin = {
    kind: 'user' as const,
    workspaceId: ws.id,
    userId: 'usr_demo',
    displayName: 'Demo',
    role: 'admin' as const,
    projectScope: null,
  };
  const act = await stack.deps.db.tenant(ws.id, (tx2) => queryActivity(tx2, admin, prj.id, { limit: 14 }));
  for (const r of [...act.items].reverse())
    say(
      `${String(r.actor_id ?? 'system').padEnd(18)} ${r.operation.padEnd(14)} ${r.result.padEnd(8)} ${r.latency_ms ?? ''}${r.latency_ms !== null ? ' ms' : ''}`,
    );
  const hist = await stack.db.system((tx2) =>
    tx2.query<{ type: string; payload: { before?: number; after?: number; reason?: string } }>(
      `select type, payload from memory_events where memory_id = $1 and tier in ('A','B') order by created_at, seq`,
      [deploymentMemoryId],
    ),
  );
  say(
    `score history of the deployment memory: ${hist.rows.map((h) => `${h.type}${h.payload.after !== undefined ? ` ${h.payload.before}->${h.payload.after}` : ''}`).join(' | ')}`,
  );
  // The relayer reports end_epoch and expires_at a few minutes after a write (L-W2, L-W2T), so scan again
  // until every stored memory has them, within a bound. Whatever is still missing is reported as pending.
  const expiryWaitMs = Number(env.DEMO_EXPIRY_WAIT_MS ?? 10 * 60_000);
  const pendingExpiry = async () =>
    Number(
      (
        await stack.db.system((tx2) =>
          tx2.query<{ n: string }>(
            `select count(*) as n from memories where project_id = $1 and write_state = 'stored' and expired = false and expires_at is null`,
            [prj.id],
          ),
        )
      ).rows[0]!.n,
    );
  const expiryStarted = clock.now();
  await expiryScan(stack.deps, { adapter: world.adapter, checkIntervalMs: 6 * 3_600_000 });
  while ((await pendingExpiry()) > 0 && clock.now() - expiryStarted < expiryWaitMs) {
    if (live) await new Promise((r) => setTimeout(r, 20_000));
    else clock.advance(20_000);
    await expiryScan(stack.deps, { adapter: world.adapter, checkIntervalMs: 6 * 3_600_000 });
  }
  const expiryWaitedS = Math.round((clock.now() - expiryStarted) / 1000);
  say(`expiry read from the relayer listing after ${expiryWaitedS} s`);
  const report = await stack.deps.db.tenant(ws.id, (tx2) =>
    evidenceReport(stack.deps, tx2, admin, prj.id, {
      walrusNetwork: env.WALRUS_NETWORK ?? 'mock',
      ...(world.delegatePublicKey ? { delegatePublicKey: world.delegatePublicKey } : {}),
      tatumNetwork: env.TATUM_NETWORK ?? 'mock',
    }),
  );
  say(
    `Walrus: ${report.walrus.storedMemories} memories stored; agent id ${String(report.walrus.agentId_delegatePublicKey).slice(0, 16)}...`,
  );
  for (const m of report.walrus.memories)
    say(
      `  blob ${m.blobId}  ${m.type.padEnd(10)} ${m.expiresAt ? `expires ${m.expiresAt}` : `expiry pending (not reported after ${expiryWaitedS} s)`}${m.endEpoch !== null && m.endEpoch !== undefined ? ` (end epoch ${m.endEpoch})` : ''}`,
    );
  say(
    `Tatum: ${report.tatum.calls} gateway calls (gRPC ${report.tatum.grpcCalls}, JSON-RPC ${report.tatum.jsonrpcCalls}), avg ${report.tatum.avgLatencyMs} ms, ~${report.tatum.creditsEstimated} credits`,
  );

  const result: DemoResult = {
    mode: world.mode,
    firstConnectionOfB: sc.firstConnection === true,
    failureShownFirst,
    failureMemoryId,
    deploymentMemoryId,
    staleDetected,
    staleFlagShownAtCheck,
    ...(correctedMemoryId ? { correctedMemoryId } : {}),
    ...(correctedConfidence !== undefined ? { correctedConfidence } : {}),
    blobIds: report.walrus.memories.map((m) => m.blobId ?? ''),
    expiries: report.walrus.memories.map((m) => m.expiresAt),
    tatumCalls: report.tatum.calls,
  };
  await world.close();
  void (null as unknown as Stack);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const r = await runDemo({ live: process.argv.includes('--live'), log: (s) => console.log(s) });
  console.log('\nResult:', JSON.stringify(r, null, 2));
  process.exit(r.failureShownFirst ? 0 : 1);
}
