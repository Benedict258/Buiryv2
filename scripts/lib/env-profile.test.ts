import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadProfile, parseEnvText } from './env-profile.js';

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
        'WALRUS_NETWORK=testnet\nTATUM_NETWORK=testnet\nWALRUS_RELAYER_URL=https://testnet.example\n',
    });
    const p = loadProfile(d, 'testnet', {});
    expect(p.env.WALRUS_RELAYER_URL).toBe('https://testnet.example');
    expect(p.names).toEqual(['TATUM_NETWORK', 'WALRUS_NETWORK', 'WALRUS_RELAYER_URL']);
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
