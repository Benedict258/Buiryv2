import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgliteDb, startHttp, type Runtime } from '../src/index.js';

let close: () => Promise<void>;
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
  const h = await startHttp(rt, 0);
  url = h.url;
  close = async () => {
    await h.close();
    await db.close();
  };
});
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

  it('leaves the API untouched', async () => {
    const h = await fetch(url + '/v1/healthz');
    expect(await h.json()).toEqual({ ok: true, data: { status: 'ok' } });
    const unknown = await fetch(url + '/v1/nope');
    expect(unknown.status).toBe(404);
  });
});
