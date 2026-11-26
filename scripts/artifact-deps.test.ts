import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Phase 16c: the artefact may hold a workspace dev tool only when a production package in it requires that tool (as
// a dependency or a peer), as `typescript` is a peer of production packages. Behaviour on made-up node_modules trees.

const check = fileURLToPath(new URL('../infra/oracle/check-artifact-deps.cjs', import.meta.url));
let dir = '';
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

const pkg = (app: string, name: string, extra: object = {}) => {
  const d = join(app, 'node_modules', ...name.split('/'));
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...extra }));
};
const run = (app: string) => {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [check, app], { encoding: 'utf8', stdio: 'pipe' }),
    };
  } catch (e) {
    const err = e as { status: number; stderr: string };
    return { code: err.status, out: String(err.stderr) };
  }
};

describe('check-artifact-deps', () => {
  it('passes a tree with no workspace dev tool', () => {
    dir = mkdtempSync(join(tmpdir(), 'buiry-art-'));
    pkg(dir, 'pg');
    expect(run(dir).code).toBe(0);
  });

  it('passes typescript when a production package lists it as a peer or a dependency', () => {
    dir = mkdtempSync(join(tmpdir(), 'buiry-art-'));
    pkg(dir, 'typescript');
    pkg(dir, '@scope/tada', { peerDependencies: { typescript: '^5' } });
    expect(run(dir).code).toBe(0);
    rmSync(join(dir, 'node_modules', '@scope'), { recursive: true });
    pkg(dir, 'plain-dep', { dependencies: { typescript: '^5' } });
    expect(run(dir).code).toBe(0);
  });

  it('refuses typescript, tsx or vitest that no production package requires, naming it', () => {
    for (const tool of ['typescript', 'tsx', 'vitest']) {
      dir = mkdtempSync(join(tmpdir(), 'buiry-art-'));
      pkg(dir, tool);
      pkg(dir, 'pg');
      const r = run(dir);
      expect(r.code, tool).toBe(4);
      expect(r.out).toContain(`${tool} is in the artefact but no production package requires it`);
      rmSync(dir, { recursive: true, force: true });
    }
    dir = '';
  });

  it('does not count a dev tool requiring itself or another dev tool', () => {
    dir = mkdtempSync(join(tmpdir(), 'buiry-art-'));
    pkg(dir, 'vitest', { peerDependencies: { typescript: '^5' } });
    pkg(dir, 'typescript');
    expect(run(dir).code).toBe(4);
  });

  it('build-artifact.sh runs this check instead of refusing any typescript folder', () => {
    const sh = execFileSync(
      'bash',
      ['-c', 'cat "$0"', fileURLToPath(new URL('../infra/oracle/build-artifact.sh', import.meta.url))],
      {
        encoding: 'utf8',
      },
    );
    expect(sh).toContain('node "$(dirname "$0")/check-artifact-deps.cjs" "$APP"');
    expect(sh).not.toMatch(/\[ -d "\$APP\/node_modules\/typescript" \]/);
  });
});
