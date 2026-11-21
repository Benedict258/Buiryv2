import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_MCP_BODY_BYTES } from '@buiry/mcp';
import { PgliteDb, startHttp, type Runtime } from '../src/index.js';
import { ConsoleMailer, mailerFromEnv, UnconfiguredMailer } from '../src/server.js';
import { MAX_BODY_BYTES } from '../src/http/context.js';

let close: () => Promise<void>;
let runtime: Runtime;
let url: string;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'buiry-dash-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Buiry</title>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(dir, '..', 'buiry-secret.txt'), 'outside');
  const db = await PgliteDb.create();
  const rt: Runtime = {
    deps: { db, now: Date.now, random: (n) => new Uint8Array(n).fill(7), secretKey: 'x'.repeat(40) },
    db,
    env: { DASHBOARD_DIR: dir },
    close: async () => {},
  };
  runtime = rt;
  const h = await startHttp(rt, 0);
  url = h.url;
  close = async () => {
    await h.close();
    await db.close();
  };
}, 60_000);
afterAll(() => close());

describe('dashboard static serving', () => {
  it('serves the app shell and falls back to it for client routes', async () => {
    const root = await fetch(url + '/');
    expect(root.headers.get('content-type')).toContain('text/html');
    expect(root.headers.get('cache-control')).toBe('no-cache');
    const deep = await fetch(url + '/w/wsp_1/p/prj_1/memory');
    expect(await deep.text()).toContain('<title>Buiry</title>');
  });

  it('caches hashed assets and never serves files outside the directory', async () => {
    const a = await fetch(url + '/assets/app.js');
    expect(a.headers.get('cache-control')).toContain('immutable');
    expect(a.headers.get('x-content-type-options')).toBe('nosniff');
    const t = await fetch(url + '/..%2Fbuiry-secret.txt');
    expect(await t.text()).not.toContain('outside');
  });

  it('reports the deployment network in the health check (onboarding preselects it)', async () => {
    runtime.deps.networks = { sui: 'testnet' };
    try {
      expect(await (await fetch(url + '/v1/healthz')).json()).toEqual({
        ok: true,
        data: { status: 'ok', network: 'testnet' },
      });
    } finally {
      delete runtime.deps.networks;
    }
  });

  it('leaves the API untouched', async () => {
    const h = await fetch(url + '/v1/healthz');
    expect(await h.json()).toEqual({ ok: true, data: { status: 'ok' } });
    const unknown = await fetch(url + '/v1/nope');
    expect(unknown.status).toBe(404);
  });
});

// Security review (docs/SECURITY_REVIEW.md, H1 and H2): requests that used to crash the process or buffer without limit.
describe('hostile requests', () => {
  it('answers a malformed percent escape with 400 and keeps serving', async () => {
    const bad = await fetch(url + '/%E0%A4%A');
    expect(bad.status).toBe(400);
    const after = await fetch(url + '/v1/healthz');
    expect(after.status).toBe(200);
  });

  it('refuses a REST body over the cap, declared or streamed without a length', async () => {
    const big = 'x'.repeat(MAX_BODY_BYTES + 10);
    const declared = await fetch(url + '/v1/auth/email/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: big }),
    });
    expect(declared.status).toBe(400);
    expect(await declared.text()).toContain('larger than');
    const enc = new TextEncoder();
    const streamed = await fetch(url + '/v1/auth/email/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new ReadableStream({
        start(ctl) {
          for (let i = 0; i < 3; i++) ctl.enqueue(enc.encode('y'.repeat(MAX_BODY_BYTES / 2)));
          ctl.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);
    expect(streamed.status).toBe(400);
    expect(await streamed.text()).toContain('larger than');
  });

  it('refuses an MCP body over the cap with 413 before authenticating', async () => {
    const r = await fetch(url + '/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer anything', 'content-type': 'application/json' },
      body: 'z'.repeat(MAX_MCP_BODY_BYTES + 1),
    });
    expect(r.status).toBe(413);
  });
});

// Security review H3: the console mailer prints sign-in links, which are bearer secrets.
describe('mailer selection', () => {
  it('never uses the console mailer in production', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      for (const env of [{ NODE_ENV: 'production' }, { NODE_ENV: 'production', BUIRY_MAILER: 'console' }]) {
        const m = mailerFromEnv(env);
        expect(m).toBeInstanceOf(UnconfiguredMailer);
        await expect(
          m.sendMagicLink('a@example.invalid', 'https://x/auth/email?token=secret'),
        ).rejects.toThrow('not configured');
      }
      expect(log).not.toHaveBeenCalled();
      expect(mailerFromEnv({})).toBeInstanceOf(ConsoleMailer);
    } finally {
      log.mockRestore();
    }
  });
});

describe('L2: static containment (dedicated test, Phase 6.2)', () => {
  it('accepts the root and files under it, refuses a sibling directory that shares the prefix', async () => {
    const { insideRoot } = await import('../src/server.js');
    const { join, sep } = await import('node:path');
    const root = join(tmpdir(), 'buiry-dist');
    expect(insideRoot(root, root)).toBe(true);
    expect(insideRoot(root, join(root, 'assets', 'app.js'))).toBe(true);
    // The pre-fix check was file.startsWith(root), which accepted these:
    expect(insideRoot(root, `${root}-other${sep}secret.txt`)).toBe(false);
    expect(insideRoot(root, `${root}x`)).toBe(false);
  });
});
