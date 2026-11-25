import { describe, expect, it } from 'vitest';
import {
  liveNetwork,
  liveNetworkLine,
  relayerNetworkProblem,
  sameWalletProblem,
  twoAccountProblems,
} from './live-guard.js';

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

// Phase 14 A: the isolation run, the handoff proof and the own-account check run on either network, with the
// canary's guards, on two accounts named BYO_A_* and BYO_B_*. Made-up values only.
describe('live network line (Phase 14)', () => {
  const main = {
    WALRUS_NETWORK: 'mainnet',
    TATUM_NETWORK: 'mainnet',
    BYO_A_RELAYER_URL: MAIN,
    BYO_B_RELAYER_URL: MAIN,
  };
  it('names the network and the relayer hosts, and keeps the mainnet opt-in', () => {
    expect(
      liveNetworkLine({ ...main, BUIRY_ALLOW_MAINNET: '1' }, ['BYO_A_RELAYER_URL', 'BYO_B_RELAYER_URL']),
    ).toEqual({
      ok: true,
      network: 'mainnet',
      line: 'network mainnet (relayer relayer.memory.walrus.xyz)',
    });
    const r = liveNetworkLine(main, ['BYO_A_RELAYER_URL']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/mainnet is refused without BUIRY_ALLOW_MAINNET=1/);
    expect(
      liveNetworkLine({ WALRUS_NETWORK: 'testnet', BYO_A_RELAYER_URL: STAGING }, ['BYO_A_RELAYER_URL']),
    ).toEqual({
      ok: true,
      network: 'testnet',
      line: 'network testnet (relayer relayer-staging.memory.walrus.xyz)',
    });
  });
  it('refuses any network other than testnet or mainnet for a live run', () => {
    const r = liveNetworkLine({ WALRUS_NETWORK: 'devnet' }, []);
    expect(r).toEqual({
      ok: false,
      message: 'refused: live runs use testnet or mainnet; the settings name devnet',
    });
  });
});

describe('two accounts (Phase 14)', () => {
  const acct = (side: 'A' | 'B', id: string, key: string) => ({
    [`BYO_${side}_RELAYER_URL`]: MAIN,
    [`BYO_${side}_ACCOUNT_ID`]: id,
    [`BYO_${side}_DELEGATE_KEY`]: key,
  });
  const ok = { ...acct('A', '0xaaa1', 'made-up-key-a'), ...acct('B', '0xbbb2', 'made-up-key-b') };

  it('accepts two complete, different accounts', () => {
    expect(twoAccountProblems(ok)).toEqual([]);
  });
  it('refuses a missing name on either account, naming it only', () => {
    const { BYO_B_DELEGATE_KEY: _k, ...noKey } = ok;
    expect(twoAccountProblems(noKey)).toEqual(['missing: BYO_B_DELEGATE_KEY (names only)']);
    const { BYO_A_ACCOUNT_ID: _i, ...noId } = ok;
    expect(twoAccountProblems(noId)).toEqual(['missing: BYO_A_ACCOUNT_ID (names only)']);
  });
  it('refuses the same account id, ignoring case and spaces, and the same delegate key', () => {
    expect(twoAccountProblems({ ...ok, BYO_B_ACCOUNT_ID: ' 0xAAA1 ' })).toEqual([
      'BYO_A_ACCOUNT_ID and BYO_B_ACCOUNT_ID are the same account; the two accounts must differ',
    ]);
    const sameKey = twoAccountProblems({ ...ok, BYO_B_DELEGATE_KEY: 'made-up-key-a' });
    expect(sameKey).toEqual([
      'BYO_A_DELEGATE_KEY and BYO_B_DELEGATE_KEY are the same key, so the same signer; the two accounts must differ',
    ]);
    expect(sameKey.join()).not.toContain('made-up-key-a');
  });
  it('refuses two accounts owned by the same wallet', () => {
    expect(sameWalletProblem('0xOWNER1', '0xowner1')).toBe(
      'both accounts are owned by the same wallet; the two accounts must have different owners',
    );
    expect(sameWalletProblem('0xowner1', '0xowner2')).toBeUndefined();
  });
  it('refuses a relayer that serves another network than the one checked', () => {
    expect(relayerNetworkProblem('testnet', 'mainnet')).toBe('the relayer serves testnet, not mainnet');
    expect(relayerNetworkProblem(undefined, 'mainnet')).toBe(
      'the relayer serves an unknown network, not mainnet',
    );
    expect(relayerNetworkProblem('mainnet', 'mainnet')).toBeUndefined();
  });
});
