import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORIGIN, makeWorld, walletKey, type World } from './http-helpers.js';

let w: World;
beforeAll(async () => {
  w = await makeWorld({ realWallet: true });
}, 60_000);
afterAll(async () => w.close());

const cookieOf = (h: Headers) => h.get('set-cookie')!.split(';')[0]!;

describe('envelope, headers and errors', () => {
  it('health is public; unknown routes and bad bodies use the error envelope with a request id', async () => {
    const h = await w.req('GET', '/v1/healthz', { headers: { 'x-request-id': 'req_abc' } });
    expect(h).toMatchObject({ status: 200, json: { ok: true, data: { status: 'ok' } } });
    expect(h.headers.get('x-request-id')).toBe('req_abc');
    expect(h.headers.get('x-content-type-options')).toBe('nosniff');
    expect(h.headers.get('cache-control')).toBe('no-store');
    const nf = await w.req('GET', '/v1/nope');
    expect(nf).toMatchObject({ status: 404, json: { ok: false, error: { code: 'not_found' } } });
    const bad = await w.req('POST', '/v1/auth/email/start', { body: { wrong: 1 } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('invalid_input');
    const notJson = await w.built.app.request('/v1/auth/email/start', {
      method: 'POST',
      body: '{not json',
      headers: { 'content-type': 'application/json' },
    });
    expect(notJson.status).toBe(400);
    const unauth = await w.req('GET', '/v1/auth/me');
    expect(unauth).toMatchObject({ status: 401, json: { error: { code: 'unauthorized' } } });
    expect(unauth.json.error.requestId).toMatch(/^req_/);
  });
});

describe('email link sign-in', () => {
  it('creates a user with a personal workspace, sets an HttpOnly cookie, and links are single use', async () => {
    const r = await w.req('POST', '/v1/auth/email/start', { body: { email: 'Amara@Northwind.example' } });
    expect(r.json).toEqual({ ok: true, data: { sent: true } });
    const link = w.mailer.sent.at(-1)!;
    expect(link.to).toBe('amara@northwind.example');
    const token = new URL(link.link).searchParams.get('token')!;
    const v = await w.req('POST', '/v1/auth/email/verify', { body: { token } });
    expect(v.status).toBe(200);
    expect(v.json.data.newUser).toBe(true);
    const sc = v.headers.get('set-cookie')!;
    expect(sc).toMatch(/buiry_session=bry_ses_/);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/Secure/i);
    expect(sc).toMatch(/SameSite=Lax/i);
    const me = await w.req('GET', '/v1/auth/me', { cookie: cookieOf(v.headers) });
    expect(me.json.data).toMatchObject({
      email: 'amara@northwind.example',
      identities: [{ provider: 'email' }],
      workspaces: [{ role: 'owner', plan: 'free' }],
    });
    expect((await w.req('POST', '/v1/auth/email/verify', { body: { token } })).status).toBe(401);
    expect((await w.req('POST', '/v1/auth/email/verify', { body: { token: 'garbage' } })).status).toBe(401);
    // signing in again reuses the same account
    await w.req('POST', '/v1/auth/email/start', { body: { email: 'amara@northwind.example' } });
    const t2 = new URL(w.mailer.sent.at(-1)!.link).searchParams.get('token')!;
    const v2 = await w.req('POST', '/v1/auth/email/verify', { body: { token: t2 } });
    expect(v2.json.data.newUser).toBe(false);
  });

  it('rejects invalid addresses, expires links, and rate limits link requests', async () => {
    expect((await w.req('POST', '/v1/auth/email/start', { body: { email: 'nope' } })).status).toBe(400);
    await w.req('POST', '/v1/auth/email/start', { body: { email: 'late@example.com' } });
    const tok = new URL(w.mailer.sent.at(-1)!.link).searchParams.get('token')!;
    w.clock.advance(16 * 60_000);
    expect((await w.req('POST', '/v1/auth/email/verify', { body: { token: tok } })).status).toBe(401);
    let last = 200;
    for (let i = 0; i < 6; i++)
      last = (await w.req('POST', '/v1/auth/email/start', { body: { email: 'spam@example.com' } })).status;
    expect(last).toBe(429);
  });
});

describe('wallet sign-in (Sui personal message, Ed25519)', () => {
  it('signs in with a valid signature; the nonce is single use', async () => {
    const sign = walletKey();
    const ch = await w.req('POST', '/v1/auth/wallet/challenge');
    expect(ch.json.data.message).toContain('does not move funds');
    expect(ch.json.data.message).toContain(ch.json.data.nonce);
    const { address, signature } = sign(ch.json.data.message);
    const v = await w.req('POST', '/v1/auth/wallet/verify', {
      body: { nonce: ch.json.data.nonce, address, signature },
    });
    expect(v.status).toBe(200);
    expect(v.json.data.newUser).toBe(true);
    const me = await w.req('GET', '/v1/auth/me', { token: v.json.data.session.token });
    expect(me.json.data.identities).toEqual([{ provider: 'wallet', subject: address.toLowerCase() }]);
    const again = await w.req('POST', '/v1/auth/wallet/verify', {
      body: { nonce: ch.json.data.nonce, address, signature },
    });
    expect(again.status).toBe(401);
  });

  it('rejects wrong keys, tampered messages, mismatched addresses and expired challenges', async () => {
    const sign = walletKey();
    const other = walletKey();
    const mk = async () =>
      (await w.req('POST', '/v1/auth/wallet/challenge')).json.data as { nonce: string; message: string };
    let c = await mk();
    const good = sign(c.message);
    expect(
      (
        await w.req('POST', '/v1/auth/wallet/verify', {
          body: { nonce: c.nonce, address: other(c.message).address, signature: good.signature },
        })
      ).status,
    ).toBe(401);
    c = await mk();
    const forged = sign(c.message + ' tampered');
    expect(
      (
        await w.req('POST', '/v1/auth/wallet/verify', {
          body: { nonce: c.nonce, address: forged.address, signature: forged.signature },
        })
      ).status,
    ).toBe(401);
    c = await mk();
    const ok = sign(c.message);
    w.clock.advance(6 * 60_000);
    expect(
      (
        await w.req('POST', '/v1/auth/wallet/verify', {
          body: { nonce: c.nonce, address: ok.address, signature: ok.signature },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await w.req('POST', '/v1/auth/wallet/verify', {
          body: { nonce: 'unknown', address: ok.address, signature: ok.signature },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await w.req('POST', '/v1/auth/wallet/verify', {
          body: { nonce: c.nonce, address: ok.address, signature: 'AAAA' },
        })
      ).status,
    ).toBe(401);
  });
});

describe('OAuth (provider adapters with test doubles)', () => {
  it('redirects to the provider, completes the callback, and state is single use', async () => {
    const start = await w.req('GET', '/v1/auth/oauth/github/start');
    expect(start.status).toBe(302);
    const loc = new URL(start.headers.get('location')!);
    const state = loc.searchParams.get('state')!;
    expect(loc.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/v1/auth/oauth/github/callback`);
    const cb = await w.req(
      'GET',
      `/v1/auth/oauth/github/callback?code=ok:gh-1001:dev@example.com&state=${state}`,
    );
    expect(cb.status).toBe(200);
    expect(cb.json.data.newUser).toBe(true);
    expect((await w.req('GET', `/v1/auth/oauth/github/callback?code=ok:gh-1001&state=${state}`)).status).toBe(
      401,
    );
    const s2 = new URL(
      (await w.req('GET', '/v1/auth/oauth/github/start')).headers.get('location')!,
    ).searchParams.get('state')!;
    expect((await w.req('GET', `/v1/auth/oauth/github/callback?code=bad&state=${s2}`)).status).toBe(401);
    expect((await w.req('GET', '/v1/auth/oauth/github/callback?code=ok:x')).status).toBe(400);
    expect((await w.req('GET', '/v1/auth/oauth/gitlab/start')).status).toBe(404);
  });

  it('links Google sign-in to the account that already owns the verified email, but never merges wallets or GitHub ids silently', async () => {
    const a = await w.signIn('shared@example.com');
    const s = new URL(
      (await w.req('GET', '/v1/auth/oauth/google/start')).headers.get('location')!,
    ).searchParams.get('state')!;
    const cb = await w.req(
      'GET',
      `/v1/auth/oauth/google/callback?code=ok:g-77:shared@example.com&state=${s}`,
    );
    expect(cb.json.data.newUser).toBe(false);
    const me = await w.req('GET', '/v1/auth/me', { token: cb.json.data.session.token });
    expect(me.json.data.id).toBe(a.userId);
    const s2 = new URL(
      (await w.req('GET', '/v1/auth/oauth/github/start')).headers.get('location')!,
    ).searchParams.get('state')!;
    const gh = await w.req(
      'GET',
      `/v1/auth/oauth/github/callback?code=ok:gh-9:shared@example.com&state=${s2}`,
    );
    expect(gh.json.data.newUser).toBe(true); // a GitHub id with the same email is a different account until linked explicitly
  });
});

describe('sessions and CSRF', () => {
  it('lists sessions, logs out one, logs out everywhere', async () => {
    const a = await w.signIn('multi@example.com');
    const b = await w.signIn('multi@example.com');
    const list = await w.req('GET', '/v1/auth/sessions', { token: a.token });
    expect(list.json.data).toHaveLength(2);
    expect(list.json.data.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect((await w.req('POST', '/v1/auth/logout', { token: b.token })).status).toBe(200);
    expect((await w.req('GET', '/v1/auth/me', { token: b.token })).status).toBe(401);
    const c = await w.signIn('multi@example.com');
    expect((await w.req('POST', '/v1/auth/logout-all', { token: a.token })).json.data.revoked).toBe(2);
    expect((await w.req('GET', '/v1/auth/me', { token: a.token })).status).toBe(401);
    expect((await w.req('GET', '/v1/auth/me', { token: c.token })).status).toBe(401);
  });

  it('cookie-authenticated writes need an allowed Origin; bearer tokens are exempt', async () => {
    const a = await w.signIn('csrf@example.com');
    const cookie = `buiry_session=${a.token}`;
    const body = { name: 'orbit-api' };
    expect((await w.req('POST', `/v1/workspaces/${a.workspaceId}/projects`, { cookie, body })).status).toBe(
      403,
    );
    expect(
      (
        await w.req('POST', `/v1/workspaces/${a.workspaceId}/projects`, {
          cookie,
          body,
          headers: { origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await w.req('POST', `/v1/workspaces/${a.workspaceId}/projects`, {
          cookie,
          body,
          headers: { origin: ORIGIN },
        })
      ).status,
    ).toBe(201);
    expect((await w.req('GET', `/v1/workspaces/${a.workspaceId}/projects`, { cookie })).status).toBe(200); // reads need no origin
    expect(
      (
        await w.req('POST', `/v1/workspaces/${a.workspaceId}/projects`, {
          token: a.token,
          body: { name: 'second' },
        })
      ).status,
    ).toBe(201);
  });
});

describe('auth endpoint rate limit', () => {
  it('limits unauthenticated auth requests per client address and sends Retry-After', async () => {
    const lim = await makeWorld({});
    const strict = (await import('../src/index.js')).createApp({
      deps: lim.stack.deps,
      authRequestsPerMinute: 3,
      auth: {
        domain: 'x',
        baseUrl: ORIGIN,
        wallet: new (await import('../src/index.js')).FakeWalletVerifier(),
        providers: {},
        mailer: lim.mailer,
      },
    });
    const call = () => strict.app.request('/v1/auth/wallet/challenge', { method: 'POST' });
    expect([(await call()).status, (await call()).status, (await call()).status]).toEqual([200, 200, 200]);
    const blocked = await call();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    await lim.close();
  }, 60_000);

  // SECURITY_REVIEW M1: X-Forwarded-For is client-controlled; it must not choose the limiter bucket.
  const limited = async (trustedProxyHops: number) => {
    const lim = await makeWorld({});
    const { createApp, FakeWalletVerifier } = await import('../src/index.js');
    const app = createApp({
      deps: lim.stack.deps,
      authRequestsPerMinute: 3,
      auth: {
        domain: 'x',
        baseUrl: ORIGIN,
        wallet: new FakeWalletVerifier(),
        providers: {},
        mailer: lim.mailer,
      },
      config: { trustedProxyHops },
    });
    const call = async (xff?: string) =>
      (
        await app.app.request('/v1/auth/wallet/challenge', {
          method: 'POST',
          headers: xff ? { 'x-forwarded-for': xff } : {},
        })
      ).status;
    return { call, close: () => lim.close() };
  };

  it('ignores X-Forwarded-For by default, so spoofed addresses share one bucket', async () => {
    const { call, close } = await limited(0);
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push(await call(`203.0.113.${i}`));
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    await close();
  }, 60_000);

  it('behind one trusted proxy, keys on the entry that proxy appended, not on entries the client wrote', async () => {
    const { call, close } = await limited(1);
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push(await call(`198.51.100.${i}, 192.0.2.7`));
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(await call('192.0.2.7, 192.0.2.8')).toBe(200); // a different real client has its own bucket
    await close();
  }, 60_000);
});
