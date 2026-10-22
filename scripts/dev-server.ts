/**
 * Local development server: the real API and MCP endpoint over mocks (storage relayer and Tatum), seeded with
 * the UI spec's sample project. A signed-in owner session is created and printed so the dashboard can be used
 * without an identity provider. Nothing here is a live service.
 *
 *   pnpm dev:api        # http://localhost:8787
 *   pnpm dev:dashboard  # http://localhost:5173 (proxies /v1 to the API)
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  AuthService,
  MemoryMailer,
  createDrain,
  startHttp,
  type Runtime,
} from '../packages/api/src/index.js';
import { expiryScan, relayerProbe } from '../packages/worker/src/index.js';
import ids from '../packages/chain/fixtures/_ids.json' with { type: 'json' };
import { mockWorld } from './lib/world.js';
import { seedOrbitApi } from './lib/seed.js';

/** Gives the sample project a lived-in history: confirmations, reports, a stale deployment and a handoff. */
async function enrich(
  stack: Awaited<ReturnType<typeof mockWorld>>['stack'],
  seeded: Awaited<ReturnType<typeof seedOrbitApi>>,
  token: string,
  url: string,
) {
  const call = (path: string, body: unknown = {}) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
  const m = seeded.memoryIds;
  for (const k of ['pnpm', 'internal', 'gas', 'release', 'prs']) await call(`/v1/memories/${m[k]}/confirm`);
  const { claude, opencode, cursor } = seeded.agents;
  const dep = await claude.backend.remember({
    text: 'Registry package deployed on mainnet at ' + ids.PKG_V3 + ', version 3.',
    type: 'deployment',
    evidence: [{ kind: 'package', id: ids.PKG_V3, network: 'sui:mainnet' }],
  });
  await opencode.backend.report({ memoryId: m.gas!, outcome: 'helped' });
  await cursor.backend.report({ memoryId: m.internal!, outcome: 'helped' });
  await opencode.backend.check({ task: 'refactor session storage' });
  await claude.backend.verify({ memoryId: dep.memoryId });
  await claude.backend.handoff({
    done: ['moved session helpers into packages/auth', 'added refresh-token tests for the happy path'],
    blocked: ['expired-token behaviour is undefined in the spec'],
    next: ['decide expiry handling', 'update the middleware'],
    reliedOn: [m.internal!, m.gas!],
  });
  await fetch(`${url}/v1/projects/${seeded.projectId}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      settings: { publicShowcase: { enabled: true, show: ['counts', 'memories', 'evidence', 'storage'] } },
    }),
  });
  await call(`/v1/workspaces/${seeded.workspaceId}/invitations`, {
    invitee: 'sam@northwind.dev',
    role: 'writer',
  });
  void stack;
}

export async function startDevServer(
  o: { port?: number; dashboardDir?: string; sessionFile?: string; log?: (s: string) => void } = {},
) {
  const log = o.log ?? console.log;
  // The sample project is seeded in a burst, so the development server raises the per-minute admission budgets.
  const world = await mockWorld({
    realTime: true,
    budgets: {
      perAgentPerMinute: 600,
      perAgentPerHour: 6000,
      perProjectPerMinute: 1200,
      perProjectPerHour: 12000,
      maxBacklog: 5000,
    },
  });
  const { stack } = world;
  const seeded = await seedOrbitApi(stack);

  const env = {
    BUIRY_BASE_URL: `http://localhost:${o.port ?? 8787}`,
    BUIRY_ALLOWED_ORIGINS: `http://localhost:${o.port ?? 8787},http://localhost:5173`,
    BUIRY_MAILER: 'memory',
    ...(o.dashboardDir ? { DASHBOARD_DIR: o.dashboardDir } : {}),
  } as Record<string, string>;
  const rt: Runtime = { deps: stack.deps, adapter: world.adapter, db: stack.db, env, close: async () => {} };
  const http = await startHttp(rt, o.port ?? 8787);

  // A sign-in for the seeded workspace's owner.
  const auth = new AuthService(stack.deps, {
    domain: 'localhost',
    baseUrl: env.BUIRY_BASE_URL!,
    mailer: new MemoryMailer(),
  } as never);
  const { session } = await auth.signIn('email', 'amara@northwind.dev', {
    email: 'amara@northwind.dev',
    name: 'Amara',
  });
  await stack.db.system((tx) =>
    tx.query(
      `insert into memberships (workspace_id, user_id, role) values ($1,$2,'owner') on conflict do nothing`,
      [seeded.workspaceId, session.userId],
    ),
  );

  await enrich(stack, seeded, session.token, http.url);

  const drain = createDrain(stack.deps, world.adapter, { pollIntervalMs: 500 });
  const timer = setInterval(() => {
    drain.tick().catch(() => {});
  }, 1000);
  await new Promise((r) => setTimeout(r, 2500));
  await drain.tick();
  await relayerProbe(stack.deps, world.adapter, 'mock-relayer').catch(() => {});
  await expiryScan(stack.deps, { adapter: world.adapter, checkIntervalMs: 6 * 3_600_000 }).catch(() => {});

  log(`Buiry dev server on ${http.url}`);
  log(`workspace ${seeded.workspaceId}   project ${seeded.projectId}`);
  log(`session token (paste on the sign-in page): ${session.token}`);
  if (o.sessionFile)
    writeFileSync(
      o.sessionFile,
      JSON.stringify({
        token: session.token,
        workspaceId: seeded.workspaceId,
        projectId: seeded.projectId,
        url: http.url,
      }),
    );
  return {
    ...seeded,
    token: session.token,
    url: http.url,
    stack,
    world,
    close: async () => {
      clearInterval(timer);
      await http.close();
      await world.close();
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await startDevServer(process.env.DASHBOARD_DIR ? { dashboardDir: process.env.DASHBOARD_DIR } : {});
}
