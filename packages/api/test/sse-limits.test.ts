import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, FakeWalletVerifier, type AppConfig } from '../src/index.js';
import { makeWorld, ORIGIN, type World } from './http-helpers.js';

// SECURITY_REVIEW M3: open activity streams are capped per user and per project, and a stream ends when the
// caller's session is revoked.

let w: World;
beforeAll(async () => {
  w = await makeWorld({});
}, 60_000);
afterAll(() => w.close());

const appWith = (config: Partial<AppConfig>) =>
  createApp({
    deps: w.stack.deps,
    auth: { domain: 'x', baseUrl: ORIGIN, wallet: new FakeWalletVerifier(), providers: {}, mailer: w.mailer },
    config: { feedIntervalMs: 20, ...config },
  });

let n = 0;
async function ownerWithProject() {
  const a = await w.signIn(`streamer${++n}@example.com`);
  const p = await w.req('POST', `/v1/workspaces/${a.workspaceId}/projects`, {
    token: a.token,
    body: { name: `streams-${n}`, networks: ['sui:mainnet'] },
  });
  return { ...a, projectId: p.json.data.id as string };
}

const open = async (app: ReturnType<typeof appWith>, projectId: string, token: string) =>
  await app.app.request(`/v1/projects/${projectId}/activity/stream`, {
    headers: { authorization: `Bearer ${token}` },
  });

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return cond();
};

describe('live stream limits', () => {
  it('caps open streams per user, and frees the slot when a stream closes', async () => {
    const app = appWith({ sseMaxPerUser: 2, sseMaxPerProject: 50 });
    const o = await ownerWithProject();
    const s1 = await open(app, o.projectId, o.token);
    const s2 = await open(app, o.projectId, o.token);
    expect([s1.status, s2.status]).toEqual([200, 200]);
    const s3 = await open(app, o.projectId, o.token);
    expect(s3.status).toBe(429);
    await s1.body!.cancel();
    expect(await waitFor(() => app.ctx.streams.count(`user:${o.userId}`) === 1)).toBe(true);
    const s4 = await open(app, o.projectId, o.token);
    expect(s4.status).toBe(200);
    await s2.body!.cancel();
    await s4.body!.cancel();
  });

  it('caps open streams per project', async () => {
    const app = appWith({ sseMaxPerUser: 10, sseMaxPerProject: 1 });
    const o = await ownerWithProject();
    const s1 = await open(app, o.projectId, o.token);
    expect(s1.status).toBe(200);
    expect((await open(app, o.projectId, o.token)).status).toBe(429);
    await s1.body!.cancel();
  });

  it('ends the stream when the session is revoked', async () => {
    const app = appWith({ sseRecheckMs: 50 });
    const o = await ownerWithProject();
    const res = await open(app, o.projectId, o.token);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    await w.built.ctx.auth.signOutEverywhere(o.userId);
    let buf = '';
    let done = false;
    const deadline = Date.now() + 5000;
    while (!done && Date.now() < deadline) {
      const r = await reader.read();
      done = r.done;
      if (r.value) buf += dec.decode(r.value);
    }
    expect(buf).toContain('event: end');
    expect(done).toBe(true);
    expect(await waitFor(() => app.ctx.streams.count(`user:${o.userId}`) === 0)).toBe(true);
  });
});
