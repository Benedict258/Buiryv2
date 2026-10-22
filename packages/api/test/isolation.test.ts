import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BuiryError, type BuiryBackend } from '@buiry/core';
import { startHttpServer } from '@buiry/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TENANT_TABLES, authenticateAgentToken, AgentBackend, MemoryService } from '../src/index.js';
import { makeWorld, type World } from './http-helpers.js';

/**
 * Mandatory cross-tenant isolation suite (architecture sections 5 and 18).
 * Tenant A holds a session, an API token and an agent token. Everything below tries to reach tenant B's
 * data (or a sibling project's data in A's own workspace) through every door, and must always fail as
 * "not found" without revealing that the target exists.
 */
let w: World;
interface Tenant {
  token: string;
  userId: string;
  workspaceId: string;
  projectId: string;
  agentToken: string;
  agentId: string;
  agentSlug: string;
  apiToken: string;
  apiTokenId: string;
  memoryId: string;
  branchMemoryId: string;
  flagId: string;
  webhookId: string;
  deliveryId: string;
  jobId: string;
  marker: string;
}
let A: Tenant;
let B: Tenant;
let A2: { projectId: string; memoryId: string; marker: string }; // sibling project inside A's workspace

async function tenant(label: string): Promise<Tenant> {
  const marker = `zebra-${label}-${Math.random().toString(36).slice(2, 8)}`;
  const s = await w.signIn(`${label}@isolation.example`);
  const post = (path: string, body: unknown) => w.req('POST', path, { token: s.token, body });
  const projectId = (
    await post(`/v1/workspaces/${s.workspaceId}/projects`, {
      name: `${label}-project`,
      networks: ['sui:mainnet'],
    })
  ).json.data.id as string;
  const ag = (await post(`/v1/projects/${projectId}/agents`, { name: `${label}-agent`, tool: 'x' })).json
    .data;
  const api = (
    await post(`/v1/workspaces/${s.workspaceId}/api-tokens`, { name: 'ci', scopes: ['read', 'write'] })
  ).json.data;
  await post(`/v1/projects/${projectId}/branches`, { name: 'feat-b' });
  const memoryId = (
    await post(`/v1/projects/${projectId}/memories`, {
      text: `Main memory ${marker} about gas limits.`,
      type: 'failure',
      status: 'confirmed',
    })
  ).json.data.memoryId as string;
  const branchMemoryId = (
    await post(`/v1/projects/${projectId}/memories`, {
      text: `Branch memory ${marker} about caching.`,
      type: 'decision',
      branch: 'feat-b',
    })
  ).json.data.memoryId as string;
  await post(`/v1/projects/${projectId}/memories`, {
    text: `Store sessions in the database ${marker}.`,
    type: 'decision',
  });
  await post(`/v1/projects/${projectId}/memories`, {
    text: `Store sessions in Redis ${marker}.`,
    type: 'decision',
  });
  const flagId = (
    (await w.req('GET', `/v1/projects/${projectId}/flags`, { token: s.token })).json.data as { id: string }[]
  )[0]!.id;
  const hook = (
    await post(`/v1/workspaces/${s.workspaceId}/webhooks`, {
      name: 'h',
      kind: 'generic',
      url: 'https://hooks.example.com/x',
      events: ['memory.created'],
    })
  ).json.data;
  const deliveryId =
    (
      (await w.req('GET', `/v1/webhooks/${hook.id}/deliveries`, { token: s.token })).json.data as {
        id: string;
      }[]
    )[0]?.id ?? ((await post(`/v1/webhooks/${hook.id}/test`, {})).json.data.id as string);
  const jobId = (
    await w.stack.db.system((tx) =>
      tx.query<{ id: string }>('select id from write_jobs where memory_id = $1', [memoryId]),
    )
  ).rows[0]!.id;
  return {
    ...s,
    projectId,
    agentToken: ag.token,
    agentId: ag.agentId,
    agentSlug: ag.slug,
    apiToken: api.token,
    apiTokenId: api.id,
    memoryId,
    branchMemoryId,
    flagId,
    webhookId: hook.id,
    deliveryId,
    jobId,
    marker,
  };
}

beforeAll(async () => {
  w = await makeWorld({ enforcePlans: false });
  A = await tenant('alice');
  B = await tenant('bob');
  // a second project in A's own workspace
  const m = `zebra-sibling-${Math.random().toString(36).slice(2, 8)}`;
  const sp = (
    await w.req('POST', `/v1/workspaces/${A.workspaceId}/projects`, {
      token: A.token,
      body: { name: 'alice-sibling' },
    })
  ).json.data.id as string;
  const sm = (
    await w.req('POST', `/v1/projects/${sp}/memories`, {
      token: A.token,
      body: { text: `Sibling memory ${m} about layout.`, type: 'fact' },
    })
  ).json.data.memoryId as string;
  A2 = { projectId: sp, memoryId: sm, marker: m };
}, 120_000);
afterAll(async () => w.close());

const code = async (p: Promise<unknown>) =>
  (
    (await p.then(
      () => null,
      (e) => e,
    )) as BuiryError | null
  )?.code ?? 'OK';
const agentOf = (t: Tenant) => w.restBackend(t.agentToken);

describe("MCP tools: tenant A's agent token against tenant B's identifiers", () => {
  const calls: [string, (b: BuiryBackend) => Promise<unknown>, string][] = [
    [
      'connect with B project id (BUIRY.md mismatch)',
      (b) => b.connect({ project: B.projectId }),
      'forbidden',
    ],
    ['connect to B branch', (b) => b.connect({ branch: 'nonexistent-in-a' }), 'not_found'],
    ['check on a branch that exists only in B', (b) => b.check({ branch: 'only-in-b' }), 'not_found'],
    [
      'remember relating to B memory (supersedes)',
      (b) =>
        b.remember({
          text: 'Probe supersede.',
          type: 'fact',
          relation: { kind: 'supersedes', memoryId: B.memoryId },
        }),
      'not_found',
    ],
    [
      'remember relating to B memory (agrees)',
      (b) =>
        b.remember({
          text: 'Probe agrees.',
          type: 'fact',
          relation: { kind: 'agrees', memoryId: B.memoryId },
        }),
      'not_found',
    ],
    [
      'remember with a namespace as the branch',
      (b) => b.remember({ text: 'Probe ns.', type: 'fact', branch: `buiry.v1.${B.projectId}.main` }),
      'invalid_input',
    ],
    [
      'recall with a namespace as the branch',
      (b) => b.recall({ query: 'x', branch: `buiry.v1.${B.projectId}.main` }),
      'invalid_input',
    ],
    ['recall on a branch only B has', (b) => b.recall({ query: B.marker, branch: 'only-in-b' }), 'not_found'],
    ['report on B memory', (b) => b.report({ memoryId: B.memoryId, outcome: 'helped' }), 'not_found'],
    ['report on B memory (wrong)', (b) => b.report({ memoryId: B.memoryId, outcome: 'wrong' }), 'not_found'],
    [
      'resolve (tombstone) B memory',
      (b) => b.resolve({ memoryId: B.memoryId, action: 'tombstone' }),
      'not_found',
    ],
    [
      'resolve (supersede by B memory)',
      (b) => b.resolve({ memoryId: B.memoryId, action: 'supersede', supersededBy: B.branchMemoryId }),
      'not_found',
    ],
    [
      'handoff relying on B memory',
      (b) => b.handoff({ done: [], blocked: [], next: [], reliedOn: [B.memoryId] }),
      'not_found',
    ],
    [
      'handoff onto B-only branch',
      (b) => b.handoff({ done: [], blocked: [], next: [], branch: 'only-in-b' }),
      'not_found',
    ],
    ['verify B memory', (b) => b.verify({ memoryId: B.memoryId }), 'not_found'],
    [
      'chain_simulate storing a failure on a foreign branch',
      (b) =>
        b.chainSimulate({ transactionBcsBase64: 'AAEC', createFailureMemory: true, branch: 'only-in-b' }),
      'verification_unavailable',
    ],
    [
      'branch switch to a foreign branch',
      (b) => b.branch({ action: 'switch', name: 'only-in-b' }),
      'not_found',
    ],
    [
      'branch propose_merge from a foreign branch',
      (b) => b.branch({ action: 'propose_merge', name: 'only-in-b' }),
      'not_found',
    ],
    [
      'branch create from a foreign parent',
      (b) => b.branch({ action: 'create', name: 'x1', from: 'only-in-b' }),
      'not_found',
    ],
    ['getMemory (resource buiry://memory/{id}) for B', (b) => b.getMemory(B.memoryId), 'not_found'],
    ['getMemory for B branch memory', (b) => b.getMemory(B.branchMemoryId), 'not_found'],
    ['getBriefing for a branch only B has', (b) => b.getBriefing('only-in-b'), 'not_found'],
  ];
  for (const [label, run, expected] of calls) {
    it(`${label} -> ${expected}`, async () => {
      expect(await code(run(agentOf(A)))).toBe(expected);
    });
  }

  it('bulk remember: foreign branch and foreign relations fail per item', async () => {
    const r = await agentOf(A).rememberBulk([
      { text: 'Bulk probe one.', type: 'fact', branch: 'only-in-b' },
      { text: 'Bulk probe two.', type: 'fact', relation: { kind: 'supersedes', memoryId: B.memoryId } },
    ]);
    expect(r.results.map((x) => (x.ok ? 'ok' : x.error.code))).toEqual(['not_found', 'not_found']);
  });

  it('sibling project in the same workspace is just as closed', async () => {
    const b = agentOf(A);
    expect(await code(b.getMemory(A2.memoryId))).toBe('not_found');
    expect(await code(b.report({ memoryId: A2.memoryId, outcome: 'helped' }))).toBe('not_found');
    expect(await code(b.connect({ project: A2.projectId }))).toBe('forbidden');
    expect(
      await code(
        b.remember({ text: 'Probe.', type: 'fact', relation: { kind: 'supersedes', memoryId: A2.memoryId } }),
      ),
    ).toBe('not_found');
  });

  it("allowed tools never return another tenant's content, even when asked for it by name", async () => {
    const b = agentOf(A);
    const blob = JSON.stringify([
      await b.recall({ query: `${B.marker} gas limits caching sessions` }),
      await b.recall({ query: `${A2.marker} layout` }),
      await b.check({ task: `${B.marker} ${A2.marker} gas caching` }),
      await b.getBriefing(),
      await b.status(),
      await b.branch({ action: 'list' }),
      await b.getProject(),
    ]);
    for (const m of [
      B.marker,
      A2.marker,
      B.projectId,
      B.workspaceId,
      B.memoryId,
      B.branchMemoryId,
      'only-in-b',
    ])
      expect(blob, m).not.toContain(m);
    expect(blob).toContain(A.marker); // sanity: it does return its own
    const st = await b.status();
    expect(st.project.id).toBe(A.projectId);
  });

  it("client-supplied namespaces are never used: extra fields are ignored and writes land in the token's namespace", async () => {
    const res = await w.req('POST', '/v1/agent/remember', {
      token: A.agentToken,
      body: {
        text: 'Namespace override attempt.',
        type: 'fact',
        namespace: `buiry.v1.${B.projectId}.main`,
        projectId: B.projectId,
        workspaceId: B.workspaceId,
      },
    });
    expect(res.status).toBe(200);
    const job = await w.stack.db.system((tx) =>
      tx.query<{ namespace: string; project_id: string }>(
        'select namespace, project_id from write_jobs where memory_id = $1',
        [res.json.data.memoryId],
      ),
    );
    expect(job.rows[0]).toEqual({ namespace: `buiry.v1.${A.projectId}.main`, project_id: A.projectId });
    const rec = await w.req('POST', '/v1/agent/recall', {
      token: A.agentToken,
      body: { query: B.marker, namespace: `buiry.v1.${B.projectId}.main`, projectId: B.projectId },
    });
    expect(JSON.stringify(rec.json)).not.toContain(B.marker);
    const mem = await w.stack.db.system((tx) =>
      tx.query<{ project_id: string }>('select project_id from memories where id = $1', [
        res.json.data.memoryId,
      ]),
    );
    expect(mem.rows[0]!.project_id).toBe(A.projectId);
  });

  it('every namespace in the queue belongs to the project that wrote it', async () => {
    const r = await w.stack.db.system((tx) =>
      tx.query<{ namespace: string; project_id: string }>('select namespace, project_id from write_jobs'),
    );
    expect(r.rows.length).toBeGreaterThan(5);
    for (const row of r.rows) expect(row.namespace.startsWith(`buiry.v1.${row.project_id}.`)).toBe(true);
  });

  it('an MCP HTTP session is bound to the token that opened it', async () => {
    const http = await startHttpServer({
      authenticate: async (token, sid) =>
        new AgentBackend(
          new MemoryService(w.stack.deps),
          await authenticateAgentToken(w.stack.deps, token, sid),
        ),
    });
    const c = new Client({ name: 'iso', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(http.url), {
      requestInit: { headers: { authorization: `Bearer ${A.agentToken}` } },
    });
    await c.connect(transport);
    const sid = transport.sessionId!;
    const hijack = await fetch(http.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${B.agentToken}`,
        'mcp-session-id': sid,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
    });
    expect(hijack.status).toBe(403);
    await c.close();
    await http.close();
  });
});

const KINDS: Record<string, () => Record<string, string>> = {
  workspace: () => ({ ':ws': B.workspaceId, ':uid': B.userId, ':id': B.workspaceId }),
  project: () => ({ ':id': B.projectId, ':ws': B.workspaceId, ':slug': 'feat-b' }),
  memory: () => ({ ':id': B.memoryId }),
  agent: () => ({ ':id': B.agentId }),
  webhook: () => ({ ':id': B.webhookId }),
  delivery: () => ({ ':id': B.deliveryId }),
  flag: () => ({ ':id': B.flagId }),
  job: () => ({ ':id': B.jobId }),
  token: () => ({ ':id': B.apiTokenId }),
};
const fill = (path: string, vars: Record<string, string>) =>
  Object.entries(vars)
    .reduce((p, [k, v]) => p.replace(k, v), path)
    .replace(/:[a-z]+/g, 'x');
const BODY = {
  name: 'x',
  text: 'x',
  type: 'fact',
  source: 'a',
  target: 'main',
  done: [],
  blocked: [],
  next: [],
  items: [{ memoryId: 'x' }],
  event: 'memory.created',
  role: 'reader',
  invitee: 'x@x.example',
  kind: 'generic',
  url: 'https://hooks.example.com/x',
  events: ['memory.created'],
  scopes: ['read'],
  pack: {},
  supersededBy: 'x',
  reason: 'x',
};

describe("REST: every user route against tenant B's identifiers", () => {
  it('registers a known scope for every route (a new route cannot silently skip this suite)', () => {
    const known = new Set([
      'none',
      'workspace',
      'project',
      'memory',
      'agent',
      'webhook',
      'delivery',
      'flag',
      'job',
      'token',
      'member',
      'session',
      'self',
    ]);
    for (const r of w.built.routes) expect(known.has(r.scope), `${r.method} ${r.path}`).toBe(true);
    const scoped = w.built.routes.filter((r) => r.auth === 'user' && KINDS[r.scope]);
    expect(scoped.length).toBeGreaterThan(55);
  });

  const callers: [string, () => string][] = [
    ['A session', () => A.token],
    ['A API token (read+write)', () => A.apiToken],
  ];
  for (const [label, tok] of callers) {
    it(`${label}: every project/memory/agent/webhook/flag/job/token/workspace route returns 404 for B's ids`, async () => {
      const failures: string[] = [];
      let n = 0;
      for (const r of w.built.routes.filter((x) => x.auth === 'user' && KINDS[x.scope])) {
        const path = fill(r.path, KINDS[r.scope]!());
        const res = await w.built.app.request(path, {
          method: r.method,
          headers: {
            authorization: `Bearer ${tok()}`,
            ...(r.method !== 'GET' ? { 'content-type': 'application/json' } : {}),
          },
          ...(r.method !== 'GET' && r.method !== 'DELETE' ? { body: JSON.stringify(BODY) } : {}),
        });
        n++;
        if (res.status !== 404) failures.push(`${r.method} ${r.path} -> ${res.status}`);
        const text = await res.text().catch(() => '');
        for (const secret of [B.marker, B.memoryId])
          if (text.includes(secret)) failures.push(`${r.method} ${r.path} leaked ${secret}`);
      }
      expect(n).toBeGreaterThan(55);
      expect(failures).toEqual([]);
    }, 120_000);
  }

  it("A's session cannot reach A's sibling project through a project-scoped API token", async () => {
    const scoped = (
      await w.req('POST', `/v1/workspaces/${A.workspaceId}/api-tokens`, {
        token: A.token,
        body: { name: 'one-project', scopes: ['read', 'write'], projectIds: [A.projectId] },
      })
    ).json.data.token as string;
    for (const path of [
      `/v1/projects/${A2.projectId}`,
      `/v1/projects/${A2.projectId}/memories`,
      `/v1/memories/${A2.memoryId}`,
      `/v1/projects/${A2.projectId}/activity`,
    ]) {
      expect((await w.req('GET', path, { token: scoped })).status, path).toBe(404);
    }
    expect(
      (
        await w.req('POST', `/v1/projects/${A2.projectId}/memories`, {
          token: scoped,
          body: { text: 'x', type: 'fact' },
        })
      ).status,
    ).toBe(404);
    expect((await w.req('GET', `/v1/projects/${A.projectId}/memories`, { token: scoped })).status).toBe(200);
    const list = await w.req('GET', `/v1/workspaces/${A.workspaceId}/projects`, { token: scoped });
    expect(list.json.data.map((p: { id: string }) => p.id)).toEqual([A.projectId]);
  });

  it("A's agent token is refused on every user route; unauthenticated calls get 401 everywhere", async () => {
    const bad: string[] = [];
    for (const r of w.built.routes.filter((x) => x.auth === 'user')) {
      const path = fill(r.path, KINDS[r.scope]?.() ?? {});
      const agent = await w.built.app.request(path, {
        method: r.method,
        headers: { authorization: `Bearer ${A.agentToken}` },
      });
      if (![401, 403].includes(agent.status)) bad.push(`agent ${r.method} ${r.path} -> ${agent.status}`);
      const anon = await w.built.app.request(path, { method: r.method });
      if (anon.status !== 401) bad.push(`anon ${r.method} ${r.path} -> ${anon.status}`);
    }
    for (const r of w.built.routes.filter((x) => x.auth === 'agent')) {
      const anon = await w.built.app.request(r.path, { method: r.method });
      if (anon.status !== 401) bad.push(`anon ${r.method} ${r.path} -> ${anon.status}`);
      const user = await w.built.app.request(r.path, {
        method: r.method,
        headers: { authorization: `Bearer ${A.token}` },
      });
      if (user.status !== 401) bad.push(`user-session ${r.method} ${r.path} -> ${user.status}`);
    }
    expect(bad).toEqual([]);
  });

  it("B's data is intact after all of the above", async () => {
    const r = await w.req('GET', `/v1/projects/${B.projectId}/memories`, { token: B.token });
    expect(r.json.data.items.map((i: { id: string; status: string }) => [i.id, i.status])).toContainEqual([
      B.memoryId,
      'confirmed',
    ]);
    expect(
      (
        await w.stack.db.system((tx) =>
          tx.query(`select 1 from activity_log where project_id = $1 and actor_id = $2`, [
            B.projectId,
            A.agentSlug,
          ]),
        )
      ).rows,
    ).toHaveLength(0);
  });
});

describe('database: row-level security is the second layer', () => {
  it("tenant A's role sees no row of tenant B in any tenant table, and cannot write one", async () => {
    const visible: string[] = [];
    await w.stack.db.tenant(A.workspaceId, async (tx) => {
      for (const t of TENANT_TABLES) {
        const r = await tx.query(`select 1 from ${t} where workspace_id = $1`, [B.workspaceId]);
        if (r.rows.length) visible.push(t);
      }
      expect((await tx.query('select 1 from workspaces where id = $1', [B.workspaceId])).rows).toHaveLength(
        0,
      );
      expect(
        (await tx.query('select 1 from write_jobs where project_id = $1', [B.projectId])).rows,
      ).toHaveLength(0);
      expect(
        (await tx.query('update memories set text = $1 where id = $2 returning id', ['hacked', B.memoryId]))
          .rows.length,
      ).toBe(0);
      expect((await tx.query('delete from agents where id = $1 returning id', [B.agentId])).rows.length).toBe(
        0,
      );
    });
    expect(visible).toEqual([]);
    const insertEach = [
      `insert into projects (id, workspace_id, name) values ('prj_evil0000001','${B.workspaceId}','evil')`,
      `insert into memories (id, workspace_id, project_id, branch_id, branch_slug, type, status, text, confidence, agent_slug, idempotency_key) values ('mem_evil0000001','${B.workspaceId}','${B.projectId}','x','main','fact','proposed','x',0.5,'x','k')`,
    ];
    for (const sql of insertEach) {
      await expect(w.stack.db.tenant(A.workspaceId, (tx) => tx.query(sql))).rejects.toThrow();
    }
  });

  it('the tenant role cannot read identity, session or challenge tables at all', async () => {
    for (const t of ['users', 'identities', 'sessions', 'auth_challenges', 'plans']) {
      await expect(
        w.stack.db.tenant(A.workspaceId, (tx) => tx.query(`select 1 from ${t}`)),
        t,
      ).rejects.toThrow();
    }
  });

  it('with no workspace context a tenant transaction sees nothing', async () => {
    const r = await w.stack.db.tenant('', (tx) => tx.query('select 1 from projects'));
    expect(r.rows).toEqual([]);
  });

  it('the audit and activity logs are append-only even for the owner role', async () => {
    await expect(w.stack.db.system((tx) => tx.query('delete from activity_log'))).rejects.toThrow(
      /append-only/,
    );
    await w.stack.db.system((tx) =>
      tx.query(`insert into audit_log (id, action) values ('aud_isolation','probe')`),
    );
    await expect(w.stack.db.system((tx) => tx.query(`update audit_log set action = 'x'`))).rejects.toThrow(
      /append-only/,
    );
    await expect(w.stack.db.system((tx) => tx.query(`delete from audit_log`))).rejects.toThrow(/append-only/);
  });
});
