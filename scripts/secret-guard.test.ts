import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  addedLinesByFile,
  findLeaks,
  findLeaksPerEnvFile,
  isLocalEnvFile,
  isSecretName,
  secretNeedles,
  stagedEnvFiles,
} from './lib/secret-guard.js';

// Every value below is MADE UP for the test. The guard reports variable names and places, never values.

const env = {
  DATABASE_URL: 'postgres://buiry:pw-made-up-1234@db.example.test:5432/buiry',
  BUIRY_SECRET_KEY: 'made-up-secret-key-0123456789abcdef0123',
  PROOF_DELEGATE_KEY: 'ab'.repeat(32),
  BUIRY_PROOF_TOKEN: 'bry_pat_madeupmadeupmadeup',
  PROOF_RELAYER_URL: 'https://relayer.example.test',
  PROOF_ACCOUNT_ID: '0x1234',
  TATUM_NETWORK: 'testnet',
  SHORT_KEY: 'abc',
};

describe('secret guard', () => {
  it('treats keys, tokens, secrets, passwords and the database URL as secret, and nothing else', () => {
    expect(isSecretName('PROOF_DELEGATE_KEY')).toBe(true);
    expect(isSecretName('BUIRY_PROOF_TOKEN')).toBe(true);
    expect(isSecretName('DATABASE_URL')).toBe(true);
    expect(isSecretName('PROOF_RELAYER_URL')).toBe(false);
    expect(isSecretName('TATUM_NETWORK')).toBe(false);
    expect(secretNeedles(env).map((n) => n.name)).toEqual([
      'DATABASE_URL',
      'DATABASE_URL (password part)',
      'BUIRY_SECRET_KEY',
      'PROOF_DELEGATE_KEY',
      'BUIRY_PROOF_TOKEN',
    ]); // SHORT_KEY is too short to check meaningfully
  });

  it('finds a value in a report or transcript, and a database password on its own', () => {
    const leaks = findLeaks(env, [
      { source: 'session-a.txt', text: `the agent printed ${'ab'.repeat(32)} by mistake` },
      { source: 'phase-9.md', text: 'connected with password pw-made-up-1234' },
      { source: 'clean.md', text: 'relayer https://relayer.example.test, account 0x1234, network testnet' },
    ]);
    expect(leaks).toEqual([
      { name: 'PROOF_DELEGATE_KEY', source: 'session-a.txt' },
      { name: 'DATABASE_URL (password part)', source: 'phase-9.md' },
    ]);
  });

  it('treats the restore target database URL as secret, whole and by its password part (Phase 12b)', () => {
    // RESTORE_DATABASE_URL holds the restore target's password (docs/OPERATIONS.md); no suffix rule covers it.
    const restore = {
      RESTORE_DATABASE_URL: 'postgres://buiry:pw-restore-made-up-5678@scratch.example.test/db',
    };
    expect(isSecretName('RESTORE_DATABASE_URL')).toBe(true);
    expect(secretNeedles(restore).map((n) => n.name)).toEqual([
      'RESTORE_DATABASE_URL',
      'RESTORE_DATABASE_URL (password part)',
    ]);
    expect(
      findLeaks(restore, [{ source: 'drill.md', text: 'restore used pw-restore-made-up-5678 today' }]),
    ).toEqual([{ name: 'RESTORE_DATABASE_URL (password part)', source: 'drill.md' }]);
  });

  it('checks only added lines of a staged diff', () => {
    const diff = [
      '+++ b/docs/notes.md',
      '-old line with bry_pat_madeupmadeupmadeup',
      '+new line without secrets',
      '+++ b/scripts/run.sh',
      '+export BUIRY_PROOF_TOKEN=bry_pat_madeupmadeupmadeup',
    ].join('\n');
    expect(findLeaks(env, addedLinesByFile(diff))).toEqual([
      { name: 'BUIRY_PROOF_TOKEN', source: 'staged scripts/run.sh' },
    ]);
  });

  it('never puts a value in what it returns', () => {
    const out = JSON.stringify(findLeaks(env, [{ source: 'x', text: Object.values(env).join(' ') }]));
    for (const v of Object.values(env).filter((v) => v.length >= 8 && !v.startsWith('https')))
      expect(out).not.toContain(v);
    expect(out).not.toContain('pw-made-up-1234');
  });
});

// Phase 12 B6: mainnet values live in .env.mainnet, which is git-ignored, compared by the guard, and refused by the
// pre-commit hook if it is ever staged.
describe('.env.mainnet', () => {
  it('is a local env file the guard compares against, like .env and .env.testnet', () => {
    for (const f of ['.env', '.env.testnet', '.env.mainnet']) expect(isLocalEnvFile(f), f).toBe(true);
    for (const f of ['.env.example', '.env.production.example', 'env.mainnet', '.env.mainnet.bak/x'])
      expect(isLocalEnvFile(f), f).toBe(false);
  });

  it('is refused when staged, wherever it sits', () => {
    expect(stagedEnvFiles(['docs/a.md', '.env.mainnet', 'sub/.env.mainnet', '.env.example', '.env'])).toEqual(
      ['.env.mainnet', 'sub/.env.mainnet', '.env'],
    );
  });

  // Phase 13 A: each env file is compared on its own. Merging them by name let .env.testnet's value hide
  // .env.mainnet's value for every shared name (BYO_A_*, WALRUS_*, TATUM_API_KEY), so mainnet secrets went unchecked.
  const testnetEnv = {
    BYO_A_DELEGATE_KEY: 'made-up-testnet-delegate-key-111111',
    TATUM_NETWORK: 'testnet',
  };
  const mainnetEnv = {
    BYO_A_DELEGATE_KEY: 'made-up-mainnet-delegate-key-222222',
    TATUM_API_KEY: 'made-up-mainnet-only-tatum-key-333333',
    TATUM_NETWORK: 'mainnet',
  };
  const leakText = [
    'testnet key made-up-testnet-delegate-key-111111',
    'mainnet key made-up-mainnet-delegate-key-222222',
    'mainnet-only made-up-mainnet-only-tatum-key-333333',
  ].join('\n');

  it('catches both values when the same name differs between .env.testnet and .env.mainnet', () => {
    const leaks = findLeaksPerEnvFile(
      [
        { file: '.env.testnet', env: testnetEnv },
        { file: '.env.mainnet', env: mainnetEnv },
      ],
      [{ source: 'report.md', text: leakText }],
    );
    expect(leaks).toEqual([
      { name: 'BYO_A_DELEGATE_KEY', envFile: '.env.testnet', source: 'report.md' },
      { name: 'BYO_A_DELEGATE_KEY', envFile: '.env.mainnet', source: 'report.md' },
      { name: 'TATUM_API_KEY', envFile: '.env.mainnet', source: 'report.md' },
    ]);
  });

  it('the guard command catches a shared-name mainnet value and a mainnet-only value, whatever the file order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'buiry-guard-'));
    try {
      const write = (name: string, env: Record<string, string>) =>
        writeFileSync(
          join(dir, name),
          Object.entries(env)
            .map(([k, v]) => `${k}=${v}`)
            .join('\n'),
        );
      write('.env.testnet', testnetEnv);
      write('.env.mainnet', mainnetEnv);
      // Only the mainnet values leak; the testnet file is listed last, as the merge used to let it win.
      writeFileSync(
        join(dir, 'report.md'),
        'mainnet key made-up-mainnet-delegate-key-222222 and made-up-mainnet-only-tatum-key-333333',
      );
      const root = fileURLToPath(new URL('..', import.meta.url));
      const run = () =>
        execFileSync(
          process.execPath,
          [
            join(root, 'node_modules/tsx/dist/cli.mjs'),
            join(root, 'scripts/secret-guard.ts'),
            '--env',
            join(dir, '.env.mainnet'),
            '--env',
            join(dir, '.env.testnet'),
            join(dir, 'report.md'),
          ],
          { encoding: 'utf8', stdio: 'pipe' },
        );
      let stderr = '';
      let code = 0;
      try {
        run();
      } catch (e) {
        code = (e as { status: number }).status;
        stderr = String((e as { stderr: unknown }).stderr);
      }
      expect(code).toBe(1);
      expect(stderr).toContain('BYO_A_DELEGATE_KEY');
      expect(stderr).toContain('TATUM_API_KEY');
      expect(stderr).not.toContain('made-up-mainnet');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('is git-ignored by its own rule', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const out = execFileSync('git', ['check-ignore', '-v', '--no-index', '.env.mainnet'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(out).toMatch(/^\.gitignore:\d+:\.env\.mainnet\t\.env\.mainnet/);
  });
});
