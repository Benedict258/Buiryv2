import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY, PgliteDb, startHttp, type Runtime } from '../src/index.js';

// Phase 2.3: every response (REST, MCP, the dashboard's static files, errors) carries the security headers, with an
// enforced Content Security Policy that refuses framing. HSTS only when the request arrived over https.

const servers: { url: string; close: () => Promise<void> }[] = [];
async function serve(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'buiry-headers-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Buiry</title>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
  const db = await PgliteDb.create();
  const rt: Runtime = {
    deps: { db, now: Date.now, random: (n) => new Uint8Array(n).fill(7), secretKey: 'x'.repeat(40) },
    db,
    env: { DASHBOARD_DIR: dir, ...env },
    close: async () => {},
  };
  const h = await startHttp(rt, 0);
  servers.push({
    url: h.url,
    // fetch keeps sockets alive; close them so the server can stop.
    close: async () => (h.server.closeAllConnections(), await h.close(), await db.close()),
  });
  return h.url;
}
let direct: string;
let behindAlb: string;
beforeAll(async () => {
  direct = await serve({});
  behindAlb = await serve({ BUIRY_TRUSTED_PROXY_HOPS: '1' });
}, 60_000);
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
}, 60_000);

const expectCommon = (h: Headers) => {
  expect(h.get('x-content-type-options')).toBe('nosniff');
  expect(h.get('referrer-policy')).toBe('no-referrer');
  expect(h.get('x-frame-options')).toBe('DENY');
  expect(h.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
  expect(h.get('content-security-policy')).toContain("frame-ancestors 'none'");
};

describe('security headers', () => {
  it('are on dashboard files, the SPA fallback, REST, MCP and error answers', async () => {
    for (const [path, init] of [
      ['/', {}],
      ['/assets/app.js', {}],
      ['/w/some/deep/route', {}],
      ['/v1/healthz', {}],
      ['/v1/auth/me', {}],
      ['/mcp', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }],
      ['/%E0%A4%A', {}],
    ] as const) {
      const res = await fetch(direct + path, init as RequestInit);
      expectCommon(res.headers);
      expect(res.headers.get('strict-transport-security'), path).toBeNull();
    }
  });

  it('sends HSTS only for https: never on a forged header without a trusted proxy, yes behind the ALB', async () => {
    const forged = await fetch(direct + '/v1/healthz', { headers: { 'x-forwarded-proto': 'https' } });
    expect(forged.headers.get('strict-transport-security')).toBeNull();
    const viaAlb = await fetch(behindAlb + '/', { headers: { 'x-forwarded-proto': 'https' } });
    expect(viaAlb.headers.get('strict-transport-security')).toBe('max-age=31536000');
    expectCommon(viaAlb.headers);
    const plainViaAlb = await fetch(behindAlb + '/', { headers: { 'x-forwarded-proto': 'http' } });
    expect(plainViaAlb.headers.get('strict-transport-security')).toBeNull();
  });

  it('keeps refusing framing when the policy is switched to Report-Only', async () => {
    const url = await serve({ BUIRY_CSP: 'report-only' });
    const res = await fetch(url + '/');
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(res.headers.get('content-security-policy-report-only')).toBe(CONTENT_SECURITY_POLICY);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});
