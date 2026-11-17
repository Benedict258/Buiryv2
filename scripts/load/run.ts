/**
 * Load and latency (Phase 10).
 *
 * Local (default): the real HTTP server over mocks (PGlite unless DATABASE_URL is set). Seeds a project to 1k, then
 * 10k memories, and at each size measures over HTTP: the briefing (buiry_check), recall, remember, the dashboard
 * memory list (plain and filtered), SSE delivery to 20 open streams, and backpressure (an agent burst over its
 * per-minute budget, and the queue backlog cap).
 *
 *   pnpm tsx scripts/load/run.ts [--sizes 1000,10000]
 *
 * Testnet (light): real relayer and gateway, in process, a handful of calls.
 *
 *   pnpm tsx scripts/with-env.ts testnet -- pnpm tsx scripts/load/run.ts --testnet
 *
 * Results go to .buiry-local/load/<stamp>.json. Prints timings only.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AuthService,
  MemoryMailer,
  createDrain,
  startHttp,
  type Runtime,
} from '../../packages/api/src/index.js';
import { RestBackend } from '../../packages/mcp/src/index.js';
import { liveWorld, mockWorld } from '../lib/world.js';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUT = join(ROOT, '.buiry-local', 'load');
mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const testnet = args.includes('--testnet');
const sizes = (args.includes('--sizes') ? args[args.indexOf('--sizes') + 1]! : '1000,10000')
  .split(',')
  .map(Number);
const say = (m: string) => console.log(`[load] ${m}`);
const results: Record<string, unknown> = {
  at: new Date().toISOString(),
  mode: testnet ? 'testnet' : 'local',
};

type Stat = { n: number; p50: number; p95: number; max: number; errors: number; firstError?: string };
const stat = (xs: number[], errors = 0): Stat => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]! : NaN);
  return { n: xs.length, p50: q(50), p95: q(95), max: s.at(-1) ?? NaN, errors };
};
async function measure(label: string, n: number, fn: (i: number) => Promise<unknown>): Promise<Stat> {
  const xs: number[] = [];
  let errors = 0;
  let firstError: string | undefined;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    try {
      await fn(i);
      xs.push(Math.round(performance.now() - t0));
    } catch (e) {
      errors++;
      firstError ??= `${(e as { code?: string }).code ?? 'error'}: ${(e as Error).message}`.slice(0, 200);
    }
  }
  const s = { ...stat(xs, errors), ...(firstError ? { firstError } : {}) };
  say(
    `${label}: p50 ${s.p50} ms, p95 ${s.p95} ms, max ${s.max} ms, errors ${errors}/${n}${firstError ? ` (${firstError})` : ''}`,
  );
  return s;
}

const TYPES = ['decision', 'fact', 'procedure', 'constraint', 'deployment', 'failure'] as const;
const TOPICS = [
  'auth',
  'sessions',
  'billing',
  'search',
  'deploy',
  'cache',
  'queue',
  'email',
  'storage',
  'api',
];
const textFor = (i: number) =>
  `Note ${i} on ${TOPICS[i % TOPICS.length]}: ${['use', 'avoid', 'prefer', 'check'][i % 4]} ${
    ['retries with backoff', 'idempotency keys', 'small batches', 'feature flags', 'read replicas'][i % 5]
  } for the ${TOPICS[(i * 7) % TOPICS.length]} module (variant ${i}).`;

async function local() {
  const world = await mockWorld({
    realTime: true,
    budgets: {
      perAgentPerMinute: 1e9,
      perAgentPerHour: 1e9,
      perProjectPerMinute: 1e9,
      perProjectPerHour: 1e9,
      maxBacklog: 1e9,
    },
  });
  const { stack } = world;
  const rt: Runtime = {
    deps: stack.deps,
    adapter: world.adapter,
    db: stack.db,
    env: { BUIRY_MAILER: 'memory', BUIRY_BASE_URL: 'http://localhost:0' },
    close: async () => {},
  };
  const http = await startHttp(rt, 0);
  const base = http.url;
  try {
    const ws = await stack.newWorkspace('Load Co');
    const prj = await stack.newProject(ws.id, 'load-api');
    const seeder = await stack.newAgent({
      workspaceId: ws.id,
      projectId: prj.id,
      name: 'seeder',
      tool: 'generic',
    });
    const agentMade = await stack.newAgent({
      workspaceId: ws.id,
      projectId: prj.id,
      name: 'probe',
      tool: 'claude-code',
    });
    const agent = new RestBackend({ baseUrl: base, token: agentMade.token });
    const auth = new AuthService(stack.deps, {
      domain: 'localhost',
      baseUrl: base,
      mailer: new MemoryMailer(),
    } as never);
    const { session } = await auth.signIn('email', 'load@example.invalid', { email: 'load@example.invalid' });
    await stack.db.system((tx) =>
      tx.query(`insert into memberships (workspace_id, user_id, role) values ($1,$2,'owner')`, [
        ws.id,
        session.userId,
      ]),
    );
    const H = { authorization: `Bearer ${session.token}` };
    const get = async (path: string) => {
      const r = await fetch(base + path, { headers: H });
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      await r.arrayBuffer();
    };

    let seeded = 0;
    for (const size of sizes) {
      const t0 = performance.now();
      while (seeded < size) {
        const batch = Array.from({ length: Math.min(20, size - seeded) }, (_, k) => ({
          text: textFor(seeded + k),
          type: TYPES[(seeded + k) % TYPES.length]!,
        }));
        await seeder.backend.rememberBulk(batch as never);
        seeded += batch.length;
      }
      const seedMs = performance.now() - t0;
      say(`seeded to ${size} memories (${Math.round(seedMs / 1000)} s for this step)`);
      const r: Record<string, unknown> = { seedSeconds: Math.round(seedMs / 1000) };
      r.briefing = await measure(`[${size}] briefing (check)`, 20, (i) =>
        agent.check({ task: `work on the ${TOPICS[i % TOPICS.length]} module` } as never),
      );
      r.recall = await measure(`[${size}] recall`, 20, (i) =>
        agent.recall({ query: `${TOPICS[i % TOPICS.length]} retries` } as never),
      );
      r.remember = await measure(`[${size}] remember`, 30, (i) =>
        agent.remember({ text: `Probe ${size}-${i}: measured write.`, type: 'fact' } as never),
      );
      r.list = await measure(`[${size}] dashboard list`, 20, () =>
        get(`/v1/projects/${prj.id}/memories?limit=50`),
      );
      r.listFiltered = await measure(`[${size}] dashboard list filtered`, 20, (i) =>
        get(
          `/v1/projects/${prj.id}/memories?limit=50&type=${TYPES[i % TYPES.length]}&q=${TOPICS[i % TOPICS.length]}`,
        ),
      );
      results[`size_${size}`] = r;
    }

    // SSE: 20 streams; time from a write to its activity event on each stream.
    const streams = 20;
    const ctrls: AbortController[] = [];
    const arrivals: Promise<number>[] = [];
    // Activity rows carry the memory id, not its text: match on the id returned by the write.
    let target = '';
    let sent = 0;
    for (let k = 0; k < streams; k++) {
      const ctrl = new AbortController();
      ctrls.push(ctrl);
      const res = await fetch(`${base}/v1/projects/${prj.id}/activity/stream`, {
        headers: H,
        signal: ctrl.signal,
      });
      const reader = res.body!.getReader();
      arrivals.push(
        (async () => {
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return NaN;
            buf += new TextDecoder().decode(value);
            if (target && buf.includes(target)) return Math.round(performance.now() - sent);
          }
        })().catch(() => NaN),
      );
    }
    await new Promise((r) => setTimeout(r, 1500));
    sent = performance.now();
    target = (
      (await agent.remember({ text: 'SSE probe event.', type: 'fact' } as never)) as { memoryId: string }
    ).memoryId;
    const times = await Promise.race([
      Promise.all(arrivals),
      new Promise<number[]>((r) => setTimeout(() => r([]), 15_000)),
    ]);
    ctrls.forEach((c) => c.abort());
    const got = times.filter((x) => Number.isFinite(x));
    results.sse = { streams, delivered: got.length, ...stat(got) };
    say(
      `SSE: ${got.length}/${streams} streams got the event; p50 ${stat(got).p50} ms, max ${stat(got).max} ms`,
    );

    // Backpressure: tight per-agent budget, then a backlog cap below the current queue.
    const saved = stack.deps.budgets;
    stack.deps.budgets = { ...saved!, perAgentPerMinute: 20, perAgentPerHour: 1e9, maxBacklog: 1e9 };
    const burstAgent = await stack.newAgent({
      workspaceId: ws.id,
      projectId: prj.id,
      name: 'burst',
      tool: 'generic',
    });
    const burst = new RestBackend({ baseUrl: base, token: burstAgent.token });
    const outcomes = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        burst.remember({ text: `Burst ${i}.`, type: 'fact' } as never).then(
          () => 'ok',
          (e: { code?: string; retryAfterMs?: number }) => `${e.code}${e.retryAfterMs ? '+retryAfter' : ''}`,
        ),
      ),
    );
    const tally = (xs: string[]) =>
      xs.reduce<Record<string, number>>((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {});
    stack.deps.budgets = { ...saved!, maxBacklog: 100 };
    const backlog = await agent.remember({ text: 'Over the backlog cap.', type: 'fact' } as never).then(
      () => 'accepted',
      (e: { code?: string; message?: string }) => `${e.code}: ${e.message}`,
    );
    stack.deps.budgets = saved!;
    results.backpressure = { agentBurst50: tally(outcomes), overBacklogCap: backlog };
    say(
      `backpressure: burst of 50 at 20/min -> ${JSON.stringify(tally(outcomes))}; over backlog cap -> ${backlog}`,
    );
  } finally {
    await http.close();
    await world.close();
  }
}

async function onTestnet() {
  const env = process.env as Record<string, string | undefined>;
  if (env.WALRUS_NETWORK !== 'testnet') throw new Error('refusing: --testnet needs the testnet profile');
  const world = await liveWorld(env);
  const s = world.stack;
  try {
    const ws = await s.newWorkspace('load-testnet');
    const prj = await s.newProject(ws.id, 'load-testnet', { networks: ['sui:testnet'] });
    const a = await s.newAgent({ workspaceId: ws.id, projectId: prj.id, name: 'load', tool: 'claude-code' });
    const ids: string[] = [];
    results.remember = await measure('[testnet] remember (accept)', 10, async (i) => {
      ids.push(
        (await a.backend.remember({ text: `Testnet load ${i}: measured.`, type: 'fact' } as never)).memoryId,
      );
    });
    const drain = createDrain(s.deps, world.adapter, { pollIntervalMs: 3000 });
    const t0 = performance.now();
    const stored = async () =>
      Number(
        (
          await s.db.system((tx) =>
            tx.query<{ n: string }>(
              `select count(*) as n from memories where id = any($1) and write_state = 'stored'`,
              [ids],
            ),
          )
        ).rows[0]!.n,
      );
    while ((await stored()) < ids.length && performance.now() - t0 < 5 * 60_000) {
      await drain.tick();
      await new Promise((r) => setTimeout(r, 3000));
    }
    results.storeAll = {
      stored: await stored(),
      of: ids.length,
      seconds: Math.round((performance.now() - t0) / 1000),
    };
    say(
      `[testnet] ${(results.storeAll as { stored: number }).stored}/${ids.length} stored in ${(results.storeAll as { seconds: number }).seconds} s`,
    );
    results.briefing = await measure('[testnet] briefing (check)', 5, () =>
      a.backend.check({ task: 'load test' } as never),
    );
    results.recall = await measure('[testnet] recall (relayer + Seal)', 5, () =>
      a.backend.recall({ query: 'testnet load measured' } as never),
    );
  } finally {
    await world.close();
  }
}

try {
  if (testnet) await onTestnet();
  else await local();
} catch (e) {
  results.error = (e as Error).message;
  say(`failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  const file = join(
    OUT,
    `${testnet ? 'testnet' : 'local'}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`,
  );
  writeFileSync(file, JSON.stringify(results, null, 2));
  say(`results: ${file}`);
}
