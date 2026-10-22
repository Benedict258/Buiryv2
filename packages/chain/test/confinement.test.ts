import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    if (['node_modules', 'dist', 'coverage', '.git'].includes(f)) continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(f)) out.push(p);
  }
  return out;
}

const files = [...walk(join(ROOT, 'packages')), ...walk(join(ROOT, 'scripts')), ...walk(join(ROOT, 'apps'))];
const rel = (f: string) => relative(ROOT, f).replaceAll('\\', '/');
const insideGateway = (f: string) =>
  rel(f) === 'packages/chain/src/tatum.ts' || rel(f).startsWith('packages/chain/src/tatum/');
const isTest = (f: string) => /\/test\//.test(rel(f)) || /\.test\.ts$/.test(f);

describe('Tatum gateway confinement', () => {
  it('only the gateway module imports chain clients', () => {
    for (const f of files) {
      if (insideGateway(f) || rel(f).startsWith('packages/chain/test/')) continue;
      const src = readFileSync(f, 'utf8');
      expect(src, rel(f)).not.toMatch(/from ['"](@grpc\/|@mysten\/|@tatumio\/)/);
      expect(src, rel(f)).not.toMatch(/gateway\.tatum\.io/);
    }
  });

  it('only the gateway module reads the Tatum API key', () => {
    for (const f of files) {
      if (insideGateway(f) || isTest(f)) continue;
      const src = readFileSync(f, 'utf8');
      expect(src, rel(f)).not.toMatch(/TATUM_API_KEY|x-api-key/i);
    }
  });

  it('no module outside packages/chain imports gateway internals or backends', () => {
    for (const f of files) {
      if (rel(f).startsWith('packages/chain/')) continue;
      const src = readFileSync(f, 'utf8');
      expect(src, rel(f)).not.toMatch(/chain\/src\/tatum\//);
    }
  });

  it('Walrus clients stay inside packages/storage', () => {
    for (const f of files) {
      if (rel(f).startsWith('packages/storage/') || rel(f).endsWith('confinement.test.ts')) continue;
      const src = readFileSync(f, 'utf8');
      expect(src, rel(f)).not.toMatch(/from ['"][^'"]*memwal/i);
      expect(src, rel(f)).not.toMatch(/\/remember\/bulk|x-delegate-key/);
    }
  });
});
