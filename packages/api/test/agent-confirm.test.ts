import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeWorld, type World } from './http-helpers.js';

// Phase 6.1, finding M8: only a person (a dashboard user) can move a memory to `confirmed`. Agent tokens may propose,
// report and contest, and agent reports may raise confidence, but never set `confirmed`, whatever session headers
// they send. Every path an agent token can reach is exercised here.

let w: World;
let owner: { token: string; workspaceId: string };
let projectId: string;
beforeAll(async () => {
  w = await makeWorld({ enforcePlans: false }); // the free plan allows 5 agents; this test needs more
  owner = await w.signIn('m8-owner@example.com');
  projectId = (
    await w.req('POST', `/v1/workspaces/${owner.workspaceId}/projects`, {
      token: owner.token,
      body: { name: 'm8', networks: ['sui:mainnet'] },
    })
  ).json.data.id;
}, 60_000);
afterAll(() => w.close());

const DAY = 24 * 3600 * 1000;
const agent = async (name: string, permissions: string[]) =>
  (
    await w.req('POST', `/v1/projects/${projectId}/agents`, {
      token: owner.token,
      body: { name, tool: 'claude-code', permissions },
    })
  ).json.data.token as string;
const call = (token: string, op: string, body: unknown, session?: string) =>
  w.req('POST', `/v1/agent/${op}`, {
    token,
    body,
    ...(session ? { headers: { 'x-buiry-session': session } } : {}),
  });
const status = async (memoryId: string) =>
  (await w.req('GET', `/v1/memories/${memoryId}`, { token: owner.token })).json.data as {
    status: string;
    confidence: number;
  };
const remember = async (token: string, text: string) =>
  (await call(token, 'remember', { text, type: 'decision' })).json.data.memoryId as string;

describe('only a person can confirm a memory (M8)', () => {
  it('one agent token reporting its own memory helpful over several days never confirms it (the 4.5 probe)', async () => {
    const tok = await agent('solo', ['read', 'write']);
    const id = await remember(tok, 'Use pnpm workspaces for the monorepo.');
    for (const [day, session] of [
      [0, undefined],
      [0, undefined],
      [1, undefined],
      [2, 'fresh-session-a'],
      [3, 'fresh-session-b'],
    ] as const) {
      if (day > 0) w.clock.advance(DAY);
      expect((await call(tok, 'report', { memoryId: id, outcome: 'helped' }, session)).status).toBe(200);
    }
    const m = await status(id);
    expect(m.status).toBe('proposed');
    expect(m.confidence).toBeGreaterThan(0.35); // reports may still raise confidence
  });

  it("another agent's helpful reports do not confirm it either", async () => {
    const a = await agent('writer-a', ['read', 'write']);
    const b = await agent('reader-b', ['read', 'write']);
    const c = await agent('reader-c', ['read', 'write']);
    const id = await remember(a, 'Never import from internal/ in app code.');
    for (const t of [b, b, c]) {
      w.clock.advance(DAY);
      await call(t, 'report', { memoryId: id, outcome: 'helped' });
    }
    expect((await status(id)).status).toBe('proposed');
  });

  it('an agent token with the confirm permission cannot confirm, through buiry_resolve, any memory', async () => {
    const writer = await agent('writer', ['read', 'write']);
    const confirmer = await agent('confirmer', ['read', 'write', 'confirm']);
    const other = await remember(writer, 'Store sessions in the database.');
    const own = await remember(confirmer, 'Run the migration in batches of 200 rows.');
    for (const id of [other, own]) {
      const r = await call(confirmer, 'resolve', { memoryId: id, action: 'confirm' });
      expect(r.status, JSON.stringify(r.json)).toBe(403);
      expect((await status(id)).status).toBe('proposed');
    }
  });

  it('memories an agent writes start proposed, including handoffs and bulk writes', async () => {
    const tok = await agent('bulk', ['read', 'write']);
    const bulk = await call(tok, 'remember_bulk', {
      items: [
        { text: 'Fact one for the bulk test.', type: 'fact' },
        { text: 'Fact two for the bulk test.', type: 'fact' },
      ],
    });
    const ids = (bulk.json.data.results as { result: { memoryId: string } }[]).map((r) => r.result.memoryId);
    const handoff = await call(tok, 'handoff', { done: ['tests'], blocked: [], next: ['review'] });
    expect(handoff.status).toBe(200);
    for (const id of ids) expect((await status(id)).status).toBe('proposed');
  });

  it("an agent's branch actions do not confirm: propose_merge only reads", async () => {
    const tok = await agent('brancher', ['read', 'write']);
    expect((await call(tok, 'branch', { action: 'create', name: 'feat-m8' })).status).toBe(200);
    const id = (await call(tok, 'remember', { text: 'Branch note.', type: 'fact', branch: 'feat-m8' })).json
      .data.memoryId as string;
    expect((await call(tok, 'branch', { action: 'propose_merge', name: 'feat-m8' })).status).toBe(200);
    expect((await status(id)).status).toBe('proposed');
  });

  it('an API token confirms only with the explicit confirm scope (Phase 7.4)', async () => {
    const mint = async (scopes: string[]) =>
      (
        await w.req('POST', `/v1/workspaces/${owner.workspaceId}/api-tokens`, {
          token: owner.token,
          body: { name: `ci-${scopes.join('-')}`, scopes },
        })
      ).json.data.token as string;
    const tok = await agent('for-api', ['read', 'write']);
    const id = await remember(tok, 'Pin dependencies exactly.');
    const plain = await w.req('POST', `/v1/memories/${id}/confirm`, {
      token: await mint(['read', 'write']),
      body: {},
    });
    expect(plain.status, JSON.stringify(plain.json)).toBe(403);
    expect((await status(id)).status).toBe('proposed');
    const scoped = await w.req('POST', `/v1/memories/${id}/confirm`, {
      token: await mint(['read', 'write', 'confirm']),
      body: {},
    });
    expect(scoped.status, JSON.stringify(scoped.json)).toBe(200);
    expect((await status(id)).status).toBe('confirmed');
  });

  it('a person can still confirm from the dashboard', async () => {
    const tok = await agent('for-human', ['read', 'write']);
    const id = await remember(tok, 'Prefer small pull requests.');
    const r = await w.req('POST', `/v1/memories/${id}/confirm`, { token: owner.token, body: {} });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await status(id)).status).toBe('confirmed');
  });
});
