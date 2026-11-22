import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StorageRegistry, buildRuntime, previewProblems, strandedWrites } from '../src/index.js';
import { makeWorld, type World } from './http-helpers.js';

// Phase 9 C1: preview mode, where every tester brings their own Walrus testnet account (BD36). With no shared
// account, a project that has not connected its own refuses writes up front with a clear message; nothing is queued
// that could never be stored. Writes queued before this change are reported, never deleted.

let w: World;
beforeAll(async () => {
  w = await makeWorld({
    stackOpts: {
      storage: new StorageRegistry({
        // No managed adapter: this deployment has no shared storage account (BUIRY_MANAGED=off).
        build: () => {
          throw new Error('no own accounts connected in this test');
        },
        tenancy: { multi: false },
      }),
    },
  });
}, 60_000);
afterAll(() => w.close());

const project = async (token: string, ws: string, name: string) =>
  (
    await w.req('POST', `/v1/workspaces/${ws}/projects`, {
      token,
      body: { name, networks: ['sui:testnet'] },
    })
  ).json.data.id as string;
const count = async (sql: string, id: string) =>
  w.stack.db.system(async (tx) => Number((await tx.query<{ n: string }>(sql, [id])).rows[0]!.n));

describe('preview mode: no shared storage account', () => {
  it('refuses an agent write up front with a clear message, and queues nothing', async () => {
    const a = await w.signIn('tester@example.com');
    const pid = await project(a.token, a.workspaceId, 'No account yet');
    const agent = await w.req('POST', `/v1/projects/${pid}/agents`, {
      token: a.token,
      body: { name: 'claude', tool: 'claude-code', permissions: ['read', 'write'] },
    });
    const r = await w
      .restBackend(agent.json.data.token)
      .remember({ text: 'First decision.', type: 'decision' })
      .then(
        () => 'stored',
        (e: { code?: string; message?: string }) => `${e.code}: ${e.message}`,
      );
    expect(r).toMatch(/^forbidden: .*no shared Walrus account.*Use your own account/);
    expect(await count('select count(*) as n from memories where project_id = $1', pid)).toBe(0);
    expect(await count('select count(*) as n from write_jobs where project_id = $1', pid)).toBe(0);
  });

  it('refuses a person writing from the dashboard too', async () => {
    const a = await w.signIn('tester2@example.com');
    const pid = await project(a.token, a.workspaceId, 'Dashboard write');
    const r = await w.req('POST', `/v1/projects/${pid}/memories`, {
      token: a.token,
      body: { text: 'A person writes.', type: 'fact' },
    });
    expect(r.status).toBe(403);
    expect(String(r.json.error?.message ?? r.json.message)).toContain('no shared Walrus account');
  });

  it('the project storage view tells the dashboard an own account is needed', async () => {
    const a = await w.signIn('tester3@example.com');
    const pid = await project(a.token, a.workspaceId, 'Storage view');
    const v = (await w.req('GET', `/v1/projects/${pid}/storage/account`, { token: a.token })).json.data;
    expect(v.needsOwnAccount).toBe(true);
    expect(v.managedAllowed).toBe(false);
    expect(v.noSharedAccount).toBe(true);
  });

  it('reports writes queued earlier for projects without an account, and does not delete them', async () => {
    const a = await w.signIn('tester4@example.com');
    const pid = await project(a.token, a.workspaceId, 'Queued before');
    await w.stack.db.system((tx) =>
      tx.query(
        `insert into write_jobs (id, memory_id, idempotency_key, namespace, project_id, agent_id, text, ref, state, attempts, next_attempt_at, created_at, updated_at)
         values ('wj_old', 'mem_old', 'idem_old', 'buiry.v1.x.main', $1, 'claude', 'body', null, 'queued', 0, $2, $2, $2)`,
        [pid, Date.now()],
      ),
    );
    const report = await w.stack.db.system((tx) => strandedWrites(w.stack.deps, tx));
    expect(report).toContainEqual({ projectId: pid, queued: 1 });
    expect(await count('select count(*) as n from write_jobs where project_id = $1', pid)).toBe(1);
  });
});

describe('preview configuration (BUIRY_PREVIEW=1)', () => {
  it('requires managed storage off and refuses multi-tenancy and a managed workspace', () => {
    expect(previewProblems({ BUIRY_PREVIEW: '1', BUIRY_MANAGED: 'off' })).toEqual([]);
    expect(previewProblems({ BUIRY_PREVIEW: '1' }).join('\n')).toContain('BUIRY_MANAGED=off');
    expect(
      previewProblems({ BUIRY_PREVIEW: '1', BUIRY_MANAGED: 'off', BUIRY_MANAGED_MULTI_TENANT: '1' }).join(
        '\n',
      ),
    ).toContain('BUIRY_MANAGED_MULTI_TENANT=1 is refused');
    expect(
      previewProblems({ BUIRY_PREVIEW: '1', BUIRY_MANAGED: 'off', BUIRY_MANAGED_WORKSPACE_ID: 'wsp_X' }).join(
        '\n',
      ),
    ).toContain('BUIRY_MANAGED_WORKSPACE_ID');
    expect(previewProblems({})).toEqual([]);
  });

  it('a preview server refuses to start with the wrong storage settings, outside production too', async () => {
    await expect(
      buildRuntime({ NODE_ENV: 'development', BUIRY_PREVIEW: '1', BUIRY_MANAGED_MULTI_TENANT: '1' }),
    ).rejects.toThrow(/refusing to start in preview[\s\S]*BUIRY_MANAGED_MULTI_TENANT=1 is refused/);
  });
});
