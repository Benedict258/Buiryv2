import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Phase 12 B1: no code path falls back to mainnet. Scans every committed source file (not tests) for an expression
// that supplies mainnet when a value is missing: `?? 'mainnet'`, `|| "sui:mainnet"`, `?? \`sui:mainnet\``.

const root = fileURLToPath(new URL('..', import.meta.url));
const FALLBACK = /(\?\?|\|\|)\s*['"`](sui:)?mainnet['"`]/;
/** Mock-only worlds whose fixtures are mainnet records; no live service is involved. */
const MOCK_ONLY = new Set(['scripts/lib/world.ts', 'scripts/real-pg/seed.ts']);

describe('no default to mainnet', () => {
  it('finds no mainnet fallback in source outside the mock-only worlds', () => {
    const files = execFileSync('git', ['ls-files', 'packages', 'apps', 'scripts', 'infra'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((f) => /\.(ts|tsx|mts|js|tf)$/.test(f) && !/(\.test\.|\/test\/|fixtures)/.test(f));
    expect(files.length).toBeGreaterThan(100);
    const hits = files.flatMap((f) =>
      readFileSync(`${root}/${f}`, 'utf8')
        .split('\n')
        .map((line, i) => ({ f, line, n: i + 1 }))
        .filter((x) => FALLBACK.test(x.line) && !MOCK_ONLY.has(x.f))
        .map((x) => `${x.f}:${x.n}`),
    );
    expect(hits).toEqual([]);
  });

  it('the mock-only worlds really are mock-only', () => {
    for (const f of MOCK_ONLY) {
      const src = readFileSync(`${root}/${f}`, 'utf8');
      const lines = src
        .split('\n')
        .filter((l) => FALLBACK.test(l) || /defaultNetwork: 'sui:mainnet'/.test(l));
      expect(lines.length, f).toBeLessThanOrEqual(1);
    }
    // The live world builds no mock: its network comes from the checked settings only.
    const world = readFileSync(`${root}/scripts/lib/world.ts`, 'utf8');
    const live = world.slice(world.indexOf('export async function liveWorld'));
    expect(live).not.toMatch(/mainnet/);
  });
});
