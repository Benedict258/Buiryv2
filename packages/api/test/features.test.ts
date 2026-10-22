/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeWorld, type World } from './http-helpers.js';

let w: World;
beforeAll(async () => {
  w = await makeWorld({ enforcePlans: false });
}, 60_000);
afterAll(async () => w.close());

async function project(email: string, name = 'orbit-api') {
  const me = await w.signIn(email);
  const p = await w.req('POST', `/v1/workspaces/${me.workspaceId}/projects`, {
    token: me.token,
    body: { name },
  });
  return { ...me, projectId: p.json.data.id as string };
}
const agent = async (m: Awaited<ReturnType<typeof project>>, name = 'claude-code') => {
  const a = await w.req('POST', `/v1/projects/${m.projectId}/agents`, {
    token: m.token,
    body: { name, tool: name },
  });
  return a.json.data.token as string;
};
const agentCall = (token: string, op: string, body: unknown = {}) =>
  w.req('POST', `/v1/agent/${op}`, { token, body });

describe('pending invitations', () => {
  it('lists open invitations without tokens, expires them, and can revoke', async () => {
    const me = await w.signIn('owner@inv.example');
    const mk = (invitee: string, hours?: number) =>
      w.req('POST', `/v1/workspaces/${me.workspaceId}/invitations`, {
        token: me.token,
        body: { invitee, role: 'writer', ...(hours ? { expiresInHours: hours } : {}) },
      });
    const a = await mk('one@example.com');
    await mk('two@example.com', 1);
    w.clock.advance(2 * 3_600_000);
    const list = await w.req('GET', `/v1/workspaces/${me.workspaceId}/invitations`, { token: me.token });
    expect(list.status).toBe(200);
    expect(list.json.data.map((x: any) => [x.invitee, x.state])).toEqual(
      expect.arrayContaining([
        ['one@example.com', 'pending'],
        ['two@example.com', 'expired'],
      ]),
    );
    expect(JSON.stringify(list.json)).not.toMatch(/inv_|token/);
    const rev = await w.req('DELETE', `/v1/workspaces/${me.workspaceId}/invitations/${a.json.data.id}`, {
      token: me.token,
    });
    expect(rev.status).toBe(200);
    const again = await w.req('DELETE', `/v1/workspaces/${me.workspaceId}/invitations/${a.json.data.id}`, {
      token: me.token,
    });
    expect(again.status).toBe(404);
    const after = await w.req('GET', `/v1/workspaces/${me.workspaceId}/invitations`, { token: me.token });
    expect(after.json.data.map((x: any) => x.invitee)).not.toContain('one@example.com');
  });

  it('is for admins of that workspace only, and an accepted invitation disappears', async () => {
    const owner = await w.signIn('owner2@inv.example');
    const other = await w.signIn('stranger@inv.example');
    const inv = await w.req('POST', `/v1/workspaces/${owner.workspaceId}/invitations`, {
      token: owner.token,
      body: { invitee: 'stranger@inv.example', role: 'reader' },
    });
    expect(
      (await w.req('GET', `/v1/workspaces/${owner.workspaceId}/invitations`, { token: other.token })).status,
    ).toBeGreaterThanOrEqual(403);
    expect(
      (
        await w.req('DELETE', `/v1/workspaces/${owner.workspaceId}/invitations/${inv.json.data.id}`, {
          token: other.token,
        })
      ).status,
    ).toBeGreaterThanOrEqual(403);
    await w.req('POST', '/v1/invitations/accept', {
      token: other.token,
      body: { token: inv.json.data.token },
    });
    const list = await w.req('GET', `/v1/workspaces/${owner.workspaceId}/invitations`, {
      token: owner.token,
    });
    expect(list.json.data).toEqual([]);
    // now a reader of that workspace still cannot list invitations
    expect(
      (await w.req('GET', `/v1/workspaces/${owner.workspaceId}/invitations`, { token: other.token })).status,
    ).toBe(403);
  });
});

describe('briefing: why this item', () => {
  it('shows score components and weights to people, never to agents', async () => {
    const m = await project('why@example.com');
    const tok = await agent(m);
    await agentCall(tok, 'remember', {
      text: 'Never import from internal/ in app code.',
      type: 'constraint',
    });
    await agentCall(tok, 'remember', {
      text: 'Migrating in one transaction exceeded the gas limit.',
      type: 'failure',
    });
    const r = await w.req('GET', `/v1/projects/${m.projectId}/briefing?task=migrate%20the%20users%20table`, {
      token: m.token,
    });
    expect(r.status).toBe(200);
    const { items, weights } = r.json.data;
    expect(weights).toEqual({ relevance: 0.5, confidence: 0.3, recency: 0.1, typeWeight: 0.1 });
    expect(items.length).toBe(2);
    for (const it of items) {
      const sum = (['relevance', 'confidence', 'recency', 'typeWeight'] as const).reduce(
        (a: number, k) => a + (weights as Record<string, number>)[k]! * it.components[k],
        0,
      );
      expect(it.score).toBeCloseTo(sum, 4);
    }
    const fail = items.find((i: any) => i.section === 'failures');
    expect(fail.components.relevance).toBeGreaterThan(0);
    const check = await agentCall(tok, 'check', { task: 'migrate the users table' });
    expect(check.json.data.items).toBeUndefined();
    expect(JSON.stringify(check.json)).not.toContain('components');
  });

  it('uses the project default token budget when none is given', async () => {
    const m = await project('budget@example.com');
    const tok = await agent(m);
    for (let i = 0; i < 12; i++)
      await agentCall(tok, 'remember', {
        text: `Decision number ${i}: we agreed to keep the module boundary number ${i} stable for all callers.`,
        type: 'decision',
      });
    const full = await w.req('GET', `/v1/projects/${m.projectId}/briefing`, { token: m.token });
    await w.req('PATCH', `/v1/projects/${m.projectId}`, {
      token: m.token,
      body: { settings: { defaultTokenBudget: 300 } },
    });
    const small = await w.req('GET', `/v1/projects/${m.projectId}/briefing`, { token: m.token });
    expect(small.json.data.tokensUsed).toBeLessThan(full.json.data.tokensUsed);
    expect(small.json.data.tokensUsed).toBeLessThanOrEqual(300);
  });
});

describe('public showcase', () => {
  const enable = (m: Awaited<ReturnType<typeof project>>, show: string[], enabled = true) =>
    w.req('PATCH', `/v1/projects/${m.projectId}`, {
      token: m.token,
      body: { settings: { publicShowcase: { enabled, show } } },
    });

  it('is private by default and does not reveal whether a project exists', async () => {
    const m = await project('show1@example.com');
    const hidden = await w.req('GET', `/v1/public/showcase/${m.projectId}`);
    const missing = await w.req('GET', '/v1/public/showcase/prj_doesnotexist');
    expect(hidden.status).toBe(404);
    const strip = (j: any) => ({ ...j, error: { ...j.error, requestId: undefined } });
    expect(strip(hidden.json)).toEqual(strip(missing.json));
    await enable(m, ['counts'], false);
    expect((await w.req('GET', `/v1/public/showcase/${m.projectId}`)).status).toBe(404);
  });

  it('shares only the ticked sections, only confirmed memories, and no agent identities', async () => {
    const m = await project('show2@example.com');
    const tok = await agent(m, 'secret-agent-name');
    const a = await agentCall(tok, 'remember', {
      text: 'Use pnpm workspaces for the monorepo.',
      type: 'decision',
    });
    await agentCall(tok, 'remember', { text: 'A proposed idea that nobody confirmed yet.', type: 'fact' });
    await w.req('POST', `/v1/memories/${a.json.data.memoryId}/confirm`, { token: m.token, body: {} });

    await enable(m, ['counts']);
    const counts = await w.req('GET', `/v1/public/showcase/${m.projectId}`);
    expect(counts.status).toBe(200);
    expect(counts.headers.get('cache-control')).toContain('public');
    expect(counts.json.data.counts.total).toBe(2);
    expect(counts.json.data.memories).toBeUndefined();
    expect(counts.json.data.storage).toBeUndefined();

    await enable(m, ['counts', 'memories', 'evidence', 'storage']);
    const full = await w.req('GET', `/v1/public/showcase/${m.projectId}`);
    expect(full.json.data.untrustedData).toBe(true);
    expect(full.json.data.memories.map((x: any) => x.text)).toEqual([
      'Use pnpm workspaces for the monorepo.',
    ]);
    expect(full.json.data.storage).toMatchObject({ mode: 'managed' });
    const raw = JSON.stringify(full.json);
    expect(raw).not.toContain('secret-agent-name');
    expect(raw).not.toContain('nobody confirmed');
    expect(raw).not.toMatch(/bry_at_|bry_ses_|workspace_id|wsp_/);
    // archived projects stop being public
    await w.req('DELETE', `/v1/projects/${m.projectId}`, { token: m.token });
    expect((await w.req('GET', `/v1/public/showcase/${m.projectId}`)).status).toBe(404);
  });
});

describe('per-address limits apply only to unauthenticated endpoints', () => {
  it('signed-in calls such as /auth/me are not limited', async () => {
    const me = await w.signIn('many@example.com');
    for (let i = 0; i < 90; i++) {
      const r = await w.req('GET', '/v1/auth/me', { token: me.token });
      expect(r.status).toBe(200);
    }
  });
});
