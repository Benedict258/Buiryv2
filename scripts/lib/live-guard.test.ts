import { describe, expect, it } from 'vitest';
import { liveNetwork } from './live-guard.js';

// Phase 12 B2: every live script checks the network settings before it builds anything. Made-up values only.

const MAIN = 'https://relayer.memory.walrus.xyz';
const STAGING = 'https://relayer-staging.memory.walrus.xyz';

describe('live script network guard', () => {
  it('refuses unset, mismatched and unrecognised settings', () => {
    expect(liveNetwork({ BYO_A_RELAYER_URL: STAGING })).toMatchObject({ ok: false });
    expect(liveNetwork({})).toMatchObject({ ok: false });
    const mixed = liveNetwork({
      WALRUS_NETWORK: 'testnet',
      BYO_A_RELAYER_URL: MAIN,
      BUIRY_ALLOW_MAINNET: '1',
    });
    expect(mixed.ok).toBe(false);
    if (!mixed.ok) expect(mixed.problems.join()).toMatch(/networks disagree/);
    expect(liveNetwork({ WALRUS_NETWORK: 'testnet', BYO_A_RELAYER_URL: 'https://r.example.test' }).ok).toBe(
      false,
    );
  });

  it("needs TATUM_NETWORK when the gateway is configured, by the chain package's own check", () => {
    const r = liveNetwork({
      WALRUS_NETWORK: 'testnet',
      BYO_A_RELAYER_URL: STAGING,
      TATUM_API_KEY: 'made-up',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join()).toMatch(/TATUM_NETWORK is not set/);
  });

  it('refuses mainnet without the opt-in and accepts it with matching values', () => {
    const env = { WALRUS_NETWORK: 'mainnet', TATUM_NETWORK: 'mainnet', BYO_A_RELAYER_URL: MAIN };
    expect(liveNetwork(env).ok).toBe(false);
    expect(liveNetwork({ ...env, BUIRY_ALLOW_MAINNET: '1' })).toEqual({ ok: true, network: 'mainnet' });
    expect(liveNetwork({ WALRUS_NETWORK: 'testnet', BYO_A_RELAYER_URL: STAGING })).toEqual({
      ok: true,
      network: 'testnet',
    });
  });
});
