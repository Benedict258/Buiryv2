import { describe, expect, it } from 'vitest';
import { buildRuntime } from '../src/server.js';
import { productionProblems } from '../src/index.js';

// Phase 11: a production server refuses weak or missing settings, naming variables only.

const good = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://buiry@db.internal:5432/buiry?sslmode=require',
  BUIRY_SECRET_KEY: 'q8VZr2LmT4nX7pK1sW9yB3cD6fH0jE5uAiGoRkMt',
  BUIRY_BASE_URL: 'https://buiry.example.com',
  BUIRY_ALLOWED_ORIGINS: 'https://buiry.example.com',
  BUIRY_MAILER: 'smtp',
  WALRUS_RELAYER_URL: 'https://relayer.example.com',
  WALRUS_ACCOUNT_ID: '0xabc',
  WALRUS_DELEGATE_KEY: '66'.repeat(32),
  WALRUS_NETWORK: 'testnet',
  TATUM_NETWORK: 'testnet',
  TATUM_API_KEY: 'not-a-real-key',
  BUIRY_MANAGED_WORKSPACE_ID: 'wsp_01M7Q03B03GCTAGNEH1C4WQQ62',
};

describe('production startup check', () => {
  it('accepts a complete configuration', () => {
    expect(productionProblems(good)).toEqual([]);
  });

  it('names every problem without echoing values', () => {
    const bad = {
      NODE_ENV: 'production',
      BUIRY_SECRET_KEY: 'changeme-changeme-changeme-changeme',
      BUIRY_BASE_URL: 'http://buiry.example.com',
      BUIRY_ALLOWED_ORIGINS: 'http://localhost:5173',
      BUIRY_MAILER: 'console',
      WALRUS_RELAYER_URL: 'https://relayer.example.com',
      WALRUS_DELEGATE_KEY: 'zz-not-a-key',
      TATUM_NETWORK: 'testnet',
      GITHUB_CLIENT_ID: 'abc',
      BUIRY_BYO_ALLOW_PRIVATE: '1',
      BUIRY_ROLE: 'everything',
    };
    const p = productionProblems(bad).join('\n');
    for (const name of [
      'DATABASE_URL',
      'BUIRY_SECRET_KEY',
      'BUIRY_BASE_URL',
      'BUIRY_ALLOWED_ORIGINS',
      'BUIRY_MAILER',
      'WALRUS_ACCOUNT_ID',
      'TATUM_API_KEY',
      'GITHUB_CLIENT_SECRET',
      'BUIRY_BYO_ALLOW_PRIVATE',
      'BUIRY_ROLE',
    ])
      expect(p).toContain(name);
    for (const value of ['changeme-changeme', 'zz-not-a-key', 'http://buiry.example.com', 'localhost:5173'])
      expect(p).not.toContain(value);
  });

  it('rejects short, placeholder and low-variety secret keys', () => {
    for (const key of ['short', 'x'.repeat(40), 'ab'.repeat(20), 'password-password-password-password'])
      expect(productionProblems({ ...good, BUIRY_SECRET_KEY: key }).join()).toContain('BUIRY_SECRET_KEY');
  });

  it('requires a named managed tenant or an explicit managed-off, and refuses multi-tenant (Phase 2.2, BD42)', () => {
    const { BUIRY_MANAGED_WORKSPACE_ID: _, ...unnamed } = good;
    expect(productionProblems(unnamed).join()).toMatch(/BUIRY_MANAGED_WORKSPACE_ID is not set/);
    expect(productionProblems({ ...good, BUIRY_MANAGED_MULTI_TENANT: '1' }).join()).toMatch(
      /BUIRY_MANAGED_MULTI_TENANT=1 is refused/,
    );
    expect(productionProblems({ ...good, BUIRY_MANAGED_WORKSPACE_ID: 'not-an-id' }).join()).toMatch(
      /not a workspace id/,
    );
    // First deploy: managed storage off, with or without the WALRUS_* values already in place.
    expect(productionProblems({ ...unnamed, BUIRY_MANAGED: 'off' })).toEqual([]);
    const { WALRUS_RELAYER_URL: _u, WALRUS_ACCOUNT_ID: _a, WALRUS_DELEGATE_KEY: _k, ...noWalrus } = unnamed;
    expect(productionProblems({ ...noWalrus, BUIRY_MANAGED: 'off' })).toEqual([]);
    expect(productionProblems(noWalrus).join()).toMatch(/set BUIRY_MANAGED=off/);
    expect(productionProblems({ ...good, BUIRY_MANAGED: 'off' }).join()).toMatch(/not both/);
    expect(productionProblems({ ...unnamed, BUIRY_MANAGED: 'on' }).join()).toMatch(/must be off or unset/);
  });

  it('builds no managed account when BUIRY_MANAGED=off, even with WALRUS_* set', async () => {
    const rt = await buildRuntime({
      BUIRY_MANAGED: 'off',
      WALRUS_NETWORK: 'testnet',
      WALRUS_RELAYER_NETWORK: 'testnet', // an unrecognised (made-up) relayer host must name its network (Phase 12)
      WALRUS_RELAYER_URL: 'https://relayer.example.com',
      WALRUS_ACCOUNT_ID: '0xabc',
      WALRUS_DELEGATE_KEY: '66'.repeat(32),
    });
    expect(rt.adapter).toBeUndefined();
    await rt.close();
  });

  it('refuses to start with a weak configuration', async () => {
    await expect(buildRuntime({ NODE_ENV: 'production', BUIRY_SECRET_KEY: 'short' })).rejects.toThrow(
      /refusing to start in production:[\s\S]*DATABASE_URL[\s\S]*BUIRY_SECRET_KEY/,
    );
  });
});
