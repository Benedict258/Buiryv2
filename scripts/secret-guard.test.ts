import { describe, expect, it } from 'vitest';
import { addedLinesByFile, findLeaks, isSecretName, secretNeedles } from './lib/secret-guard.js';

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
