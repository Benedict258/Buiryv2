import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeWorld, type World } from './http-helpers.js';

// Phase 7.4: API tokens act as a person, so they get a default expiry, confirming is an explicit `confirm` scope that
// is off by default, and agent connections refuse them with a clear message.

const DAY = 86_400_000;
let w: World;
let owner: { token: string; workspaceId: string };
let projectId: string;
beforeAll(async () => {
  w = await makeWorld({ enforcePlans: false });
  owner = await w.signIn('api-tokens@example.com');
  projectId = (
    await w.req('POST', `/v1/workspaces/${owner.workspaceId}/projects`, {
      token: owner.token,
      body: { name: 'api-tokens', networks: ['sui:mainnet'] },
    })
  ).json.data.id;
}, 60_000);
afterAll(() => w.close());

const mint = async (scopes: string[], extra: Record<string, unknown> = {}) => {
  const r = await w.req('POST', `/v1/workspaces/${owner.workspaceId}/api-tokens`, {
    token: owner.token,
    body: { name: `t-${scopes.join('-')}`, scopes, ...extra },
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.data as { id: string; token: string };
};
const agentMemory = async (text: string) => {
  const agent = (
    await w.req('POST', `/v1/projects/${projectId}/agents`, {
      token: owner.token,
      body: { name: 'writer', tool: 'claude-code', permissions: ['read', 'write'] },
    })
  ).json.data.token as string;
  return (await w.req('POST', '/v1/agent/remember', { token: agent, body: { text, type: 'decision' } })).json
    .data.memoryId as string;
};
const status = async (id: string) =>
  ((await w.req('GET', `/v1/memories/${id}`, { token: owner.token })).json.data as { status: string }).status;

describe('API tokens (Phase 7.4)', () => {
  it('cannot confirm without the confirm scope, which is off by default', async () => {
    const id = await agentMemory('Store sessions in the database.');
    const plain = await mint(['read', 'write']);
    const r = await w.req('POST', `/v1/memories/${id}/confirm`, { token: plain.token, body: {} });
    expect(r.status, JSON.stringify(r.json)).toBe(403);
    expect(r.json.error.message).toMatch(/confirm scope/);
    expect(await status(id)).toBe('proposed');

    const confirming = await mint(['read', 'write', 'confirm']);
    expect(
      (await w.req('POST', `/v1/memories/${id}/confirm`, { token: confirming.token, body: {} })).status,
    ).toBe(200);
    expect(await status(id)).toBe('confirmed');
  });

  it('cannot create a memory as confirmed without the confirm scope (it is created proposed)', async () => {
    const plain = await mint(['read', 'write']);
    const r = await w.req('POST', `/v1/projects/${projectId}/memories`, {
      token: plain.token,
      body: { text: 'Pin dependencies exactly.', type: 'decision', status: 'confirmed' },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(await status(r.json.data.memoryId)).toBe('proposed');
  });

  it('a merge by a token without the confirm scope brings memories in as proposed', async () => {
    expect(
      (
        await w.req('POST', `/v1/projects/${projectId}/branches`, {
          token: owner.token,
          body: { name: 'feat-tok' },
        })
      ).status,
    ).toBe(201);
    const src = await w.req('POST', `/v1/projects/${projectId}/memories`, {
      token: owner.token,
      body: {
        text: 'Feature decision on the branch.',
        type: 'decision',
        branch: 'feat-tok',
        status: 'confirmed',
      },
    });
    expect(await status(src.json.data.memoryId)).toBe('confirmed');
    const admin = await mint(['read', 'write', 'admin']);
    const m = await w.req('POST', `/v1/projects/${projectId}/merge`, {
      token: admin.token,
      body: { source: 'feat-tok', target: 'main', items: [{ memoryId: src.json.data.memoryId }] },
    });
    expect(m.status, JSON.stringify(m.json)).toBe(201);
    const main = (
      await w.req('GET', `/v1/projects/${projectId}/memories?branch=main`, { token: owner.token })
    ).json.data.items as { text: string; status: string }[];
    expect(main.find((x) => x.text === 'Feature decision on the branch.')?.status).toBe('proposed');
  });

  it('agent connections refuse an API token with a clear message', async () => {
    const t = await mint(['read', 'write']);
    for (const op of ['connect', 'check', 'remember']) {
      const r = await w.req('POST', `/v1/agent/${op}`, { token: t.token, body: {} });
      expect(r.status).toBe(401);
      expect(r.json.error.message).toMatch(/API token.*acts as a person.*agent token/);
    }
  });

  // Last: it moves the clock 91 days, which also ends the owner session used above.
  it('expire after 90 days by default', async () => {
    const t = await mint(['read']);
    const listed = (
      await w.req('GET', `/v1/workspaces/${owner.workspaceId}/api-tokens`, { token: owner.token })
    ).json.data as { id: string; expires_at: string | null }[];
    const row = listed.find((x) => x.id === t.id)!;
    expect(row.expires_at).not.toBeNull();
    const days = (Date.parse(row.expires_at!) - w.clock.now()) / DAY;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThanOrEqual(90);
    expect((await w.req('GET', `/v1/projects/${projectId}`, { token: t.token })).status).toBe(200);
    w.clock.advance(91 * DAY);
    expect((await w.req('GET', `/v1/projects/${projectId}`, { token: t.token })).status).toBe(401);
  });
});
