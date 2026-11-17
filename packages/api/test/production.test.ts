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

  it('refuses to start with a weak configuration', async () => {
    await expect(buildRuntime({ NODE_ENV: 'production', BUIRY_SECRET_KEY: 'short' })).rejects.toThrow(
      /refusing to start in production:[\s\S]*DATABASE_URL[\s\S]*BUIRY_SECRET_KEY/,
    );
  });
});
