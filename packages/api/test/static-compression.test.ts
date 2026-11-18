import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgliteDb, chooseEncoding, startHttp, type Runtime } from '../src/index.js';

// Phase 2.4: the dashboard's text assets are sent compressed when the client accepts it; fonts never are.

const JS = 'export const greeting = "hello from the dashboard bundle";\n'.repeat(400);
let url: string;
let close: () => Promise<void>;
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'buiry-gzip-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Buiry</title>' + '<p>x</p>'.repeat(50));
  writeFileSync(join(dir, 'assets', 'app.js'), JS);
  writeFileSync(join(dir, 'assets', 'font.woff2'), Buffer.alloc(2000, 7));
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
    h.server.closeAllConnections();
    await h.close();
    await db.close();
  };
}, 60_000);
afterAll(() => close(), 60_000);

/** Raw request (no automatic decompression), so the bytes on the wire can be measured. */
function raw(path: string, acceptEncoding?: string) {
  return new Promise<{ headers: Record<string, string | string[] | undefined>; body: Buffer }>((ok, fail) => {
    get(url + path, { headers: acceptEncoding ? { 'accept-encoding': acceptEncoding } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => ok({ headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', fail);
  });
}

describe('static compression', () => {
  it('sends brotli or gzip to clients that accept it, and the bytes decode to the original', async () => {
    const br = await raw('/assets/app.js', 'gzip, deflate, br');
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers.vary).toBe('Accept-Encoding');
    expect(brotliDecompressSync(br.body).toString()).toBe(JS);
    expect(br.body.length).toBeLessThan(JS.length / 10);

    const gz = await raw('/assets/app.js', 'gzip');
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(gz.body).toString()).toBe(JS);

    const html = await raw('/w/some/route', 'br');
    expect(html.headers['content-encoding']).toBe('br');
    expect(html.headers['cache-control']).toBe('no-cache');
  });

  it('sends identity when the client does not accept compression, and never compresses fonts', async () => {
    const plain = await raw('/assets/app.js');
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body.toString()).toBe(JS);
    const refused = await raw('/assets/app.js', 'br;q=0, gzip;q=0');
    expect(refused.headers['content-encoding']).toBeUndefined();
    const font = await raw('/assets/font.woff2', 'br, gzip');
    expect(font.headers['content-encoding']).toBeUndefined();
    expect(font.body.length).toBe(2000);
  });

  it('parses Accept-Encoding with quality values', () => {
    expect(chooseEncoding('gzip, br')).toBe('br');
    expect(chooseEncoding('br;q=0, gzip')).toBe('gzip');
    expect(chooseEncoding('*')).toBe('br');
    expect(chooseEncoding('identity')).toBeUndefined();
    expect(chooseEncoding(undefined)).toBeUndefined();
  });
});
