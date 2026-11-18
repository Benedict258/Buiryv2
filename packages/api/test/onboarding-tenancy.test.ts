import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WalrusMemoryAdapter } from '@buiry/storage';
import { StorageRegistry } from '../src/index.js';
import { makeWorld, type World } from './http-helpers.js';

// Phase D: onboarding under the single-tenant shared account. The first user's personal workspace is reused, their
// first managed project claims the shared account and works; a second user gets a clear, actionable path (connect
// their own Walrus account) instead of a dead end.

let w: World;
beforeAll(async () => {
  w = await makeWorld({
    stackOpts: {
      storage: new StorageRegistry({
        managed: {} as WalrusMemoryAdapter, // writes only queue in these tests; the adapter is not called
        build: () => {
          throw new Error('no own accounts connected in this test');
        },
        tenancy: { multi: false },
      }),
    },
  });
}, 60_000);
afterAll(() => w.close());

type Me = { workspaces: { id: string; name: string; projects: number }[] };
const me = async (token: string) => (await w.req('GET', '/v1/auth/me', { token })).json.data as Me;
const project = async (token: string, ws: string, name: string, walrusMode?: 'managed' | 'byo') =>
  (
    await w.req('POST', `/v1/workspaces/${ws}/projects`, {
      token,
      body: { name, networks: ['sui:mainnet'], ...(walrusMode ? { walrusMode } : {}) },
    })
  ).json.data.id as string;
const agentWrite = async (token: string, projectId: string) => {
  const a = await w.req('POST', `/v1/projects/${projectId}/agents`, {
    token,
    body: { name: 'claude', tool: 'claude-code', permissions: ['read', 'write'] },
  });
  return w
    .restBackend(a.json.data.token)
    .remember({ text: 'First decision.', type: 'decision' })
    .then(
      () => 'stored',
      (e: { code?: string; message?: string }) => `${e.code}: ${e.message}`,
    );
};

describe('onboarding under the single-tenant shared account', () => {
  it("reuses the first user's personal workspace, and their first managed project works", async () => {
    const a = await w.signIn('first@example.com');
    const before = await me(a.token);
    expect(before.workspaces).toHaveLength(1);
    expect(before.workspaces[0]!.projects).toBe(0);

    const renamed = await w.req('PATCH', `/v1/workspaces/${a.workspaceId}`, {
      token: a.token,
      body: { name: 'First Labs' },
    });
    expect(renamed.status).toBe(200);
    const after = await me(a.token);
    expect(after.workspaces).toEqual([expect.objectContaining({ id: a.workspaceId, name: 'First Labs' })]);

    const policy = await w.req('GET', `/v1/workspaces/${a.workspaceId}/storage-policy`, { token: a.token });
    expect(policy.json.data).toEqual({ managedAvailable: true });
    const pid = await project(a.token, a.workspaceId, 'first-api');
    expect(await agentWrite(a.token, pid)).toBe('stored');
    expect((await me(a.token)).workspaces[0]!.projects).toBe(1);

    // A project set up for its own account never falls back to the shared one, even here.
    const own = await project(a.token, a.workspaceId, 'first-own', 'byo');
    expect(await agentWrite(a.token, own)).toMatch(/^forbidden: .*not connected yet.*Storage/);
  });

  it('tells a second user to connect their own Walrus account, in the API, the agent error and the dashboard data', async () => {
    const b = await w.signIn('second@example.com');
    const policy = await w.req('GET', `/v1/workspaces/${b.workspaceId}/storage-policy`, { token: b.token });
    expect(policy.json.data.managedAvailable).toBe(false);
    expect(policy.json.data.reason).toMatch(/serves another workspace.*own Walrus Memory account/);

    // A managed project is still created (no dead end), but agents get an actionable refusal for writes.
    const managed = await project(b.token, b.workspaceId, 'second-api');
    const write = await agentWrite(b.token, managed);
    expect(write).toMatch(/^forbidden: .*serves another workspace.*Storage, Use your own account/);
    const view = await w.req('GET', `/v1/projects/${managed}/storage/account`, { token: b.token });
    expect(view.json.data).toMatchObject({ mode: 'managed', managedAllowed: false, needsOwnAccount: true });

    // The path onboarding offers: a project that brings its own account.
    const own = await project(b.token, b.workspaceId, 'second-own', 'byo');
    const ownView = await w.req('GET', `/v1/projects/${own}/storage/account`, { token: b.token });
    expect(ownView.json.data).toMatchObject({ requested: 'byo', needsOwnAccount: true });
    expect(await agentWrite(b.token, own)).toMatch(/^forbidden: .*not connected yet/);

    // The first user still owns the shared account (claimed at project creation, not by who wrote first).
    expect((await me(b.token)).workspaces).toHaveLength(1);
  });
});
