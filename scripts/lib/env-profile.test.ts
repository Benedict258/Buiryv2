import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadProfile, parseEnvText, quoteForCmd } from './env-profile.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const root = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), 'buiry-env-'));
  dirs.push(d);
  for (const [f, t] of Object.entries(files)) writeFileSync(join(d, f), t);
  return d;
};

describe('environment profiles (B5)', () => {
  it('parses CRLF files, export prefixes and quotes, and skips empty values', () => {
    expect(parseEnvText('A=1\r\nexport B="two"\r\n# c\r\nC=\r\nD = \'x y\'\r\n')).toEqual({
      A: '1',
      B: 'two',
      D: 'x y',
    });
  });

  it('loads only .env.<profile> and never falls back to .env', () => {
    const d = root({ '.env': 'WALRUS_NETWORK=mainnet\nWALRUS_RELAYER_URL=https://mainnet.example\n' });
    expect(() => loadProfile(d, 'testnet', {})).toThrow(
      'profile file .env.testnet not found; it is never replaced by .env',
    );
  });

  it('returns the profile values and only their names for reporting', () => {
    const d = root({
      '.env': 'WALRUS_RELAYER_URL=https://mainnet.example\n',
      '.env.testnet':
        'WALRUS_NETWORK=testnet\nTATUM_NETWORK=testnet\nWALRUS_RELAYER_URL=https://testnet.example\nWALRUS_RELAYER_NETWORK=testnet\n',
    });
    const p = loadProfile(d, 'testnet', {});
    expect(p.env.WALRUS_RELAYER_URL).toBe('https://testnet.example');
    expect(p.names).toEqual([
      'TATUM_NETWORK',
      'WALRUS_NETWORK',
      'WALRUS_RELAYER_NETWORK',
      'WALRUS_RELAYER_URL',
    ]);
  });

  it('refuses a testnet profile that names another network', () => {
    const d = root({ '.env.testnet': 'WALRUS_NETWORK=testnet\nTATUM_NETWORK=mainnet\n' });
    expect(() => loadProfile(d, 'testnet', {})).toThrow(
      '.env.testnet sets TATUM_NETWORK=mainnet, which is not testnet',
    );
  });

  it('refuses when the calling shell already sets a variable the profile owns', () => {
    const d = root({ '.env.testnet': 'WALRUS_NETWORK=testnet\n' });
    expect(() => loadProfile(d, 'testnet', { WALRUS_DELEGATE_KEY: 'x', PATH: '/bin' })).toThrow(
      'the calling environment already sets WALRUS_DELEGATE_KEY; unset them',
    );
  });

  it('rejects path-like profile names', () => {
    expect(() => loadProfile(root({}), '../x', {})).toThrow('invalid profile name');
  });
});

describe('Windows argument quoting for the profile runner', () => {
  it('leaves plain arguments alone and quotes ones with spaces or quotes', () => {
    expect(quoteForCmd('--live')).toBe('--live');
    expect(quoteForCmd('a b')).toBe('"a b"');
    expect(quoteForCmd('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteForCmd('')).toBe('""');
  });
});

// Phase 12 B6: mainnet values live in .env.mainnet only; a profile is checked for consistency as it loads.
describe('profile network consistency (Phase 12)', () => {
  const MAIN = 'https://relayer.memory.walrus.xyz';
  const STAGING = 'https://relayer-staging.memory.walrus.xyz';

  it('refuses a testnet file that carries a mainnet relayer, for any account in it', () => {
    const d = root({
      '.env.testnet': `WALRUS_NETWORK=testnet\nTATUM_NETWORK=testnet\nWALRUS_RELAYER_URL=${STAGING}\nBYO_A_RELAYER_URL=${MAIN}\n`,
    });
    expect(() => loadProfile(d, 'testnet', {})).toThrow(
      /\.env\.testnet is inconsistent: networks disagree: .*BYO_A_RELAYER_URL host relayer\.memory\.walrus\.xyz=mainnet/,
    );
  });

  it('refuses the mainnet opt-in anywhere near a testnet profile', () => {
    const file = `WALRUS_NETWORK=testnet\nWALRUS_RELAYER_URL=${STAGING}\n`;
    expect(() =>
      loadProfile(root({ '.env.testnet': `${file}BUIRY_ALLOW_MAINNET=1\n` }), 'testnet', {}),
    ).toThrow('BUIRY_ALLOW_MAINNET is set with profile testnet; it belongs to the mainnet profile only');
    expect(() =>
      loadProfile(root({ '.env.testnet': file }), 'testnet', { BUIRY_ALLOW_MAINNET: '1' }),
    ).toThrow('BUIRY_ALLOW_MAINNET is set with profile testnet');
  });

  it('loads .env.mainnet only with the opt-in and matching values', () => {
    const file = `WALRUS_NETWORK=mainnet\nTATUM_NETWORK=mainnet\nWALRUS_RELAYER_URL=${MAIN}\n`;
    expect(() => loadProfile(root({ '.env.mainnet': file }), 'mainnet', {})).toThrow(
      /mainnet is refused without BUIRY_ALLOW_MAINNET=1/,
    );
    expect(loadProfile(root({ '.env.mainnet': file }), 'mainnet', { BUIRY_ALLOW_MAINNET: '1' }).name).toBe(
      'mainnet',
    );
    expect(loadProfile(root({ '.env.mainnet': `${file}BUIRY_ALLOW_MAINNET=1\n` }), 'mainnet', {}).name).toBe(
      'mainnet',
    );
    // A testnet relayer in the mainnet file is refused like the reverse.
    expect(() =>
      loadProfile(
        root({ '.env.mainnet': `WALRUS_NETWORK=mainnet\nWALRUS_RELAYER_URL=${STAGING}\n` }),
        'mainnet',
        { BUIRY_ALLOW_MAINNET: '1' },
      ),
    ).toThrow(/networks disagree/);
  });

  it('refuses a network profile that names no network at all', () => {
    expect(() =>
      loadProfile(root({ '.env.mainnet': 'X=1\n' }), 'mainnet', { BUIRY_ALLOW_MAINNET: '1' }),
    ).toThrow(/no network is set/);
  });
});
