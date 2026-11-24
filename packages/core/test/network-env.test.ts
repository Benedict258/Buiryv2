import { describe, expect, it } from 'vitest';
import { HOSTED_RELAYER_HOSTS, checkNetworkEnv, relayerHostNetwork } from '../src/index.js';

// Phase 12 B: the network is always named, the relayer host agrees with it, and mainnet needs an explicit opt-in.
// Every URL and value is made up for the test except the two documented hosted relayer hosts.

const MAIN = 'https://relayer.memory.walrus.xyz';
const STAGING = 'https://relayer-staging.memory.walrus.xyz';
const live = { requireNetwork: true, gatewayConfigured: true };

describe('relayer host network', () => {
  it('knows the hosted mainnet and testnet relayers and nothing else', () => {
    expect(HOSTED_RELAYER_HOSTS).toEqual({
      'relayer.memory.walrus.xyz': 'mainnet',
      'relayer.dev.memwal.ai': 'testnet',
      'relayer-staging.memory.walrus.xyz': 'testnet',
    });
    expect(relayerHostNetwork(MAIN)).toBe('mainnet');
    expect(relayerHostNetwork('https://relayer.dev.memwal.ai')).toBe('testnet');
    expect(relayerHostNetwork(`${STAGING}/`)).toBe('testnet');
    expect(relayerHostNetwork('https://RELAYER.memory.walrus.xyz:443/x')).toBe('mainnet');
    expect(relayerHostNetwork('https://relayer.example.test')).toBeUndefined();
    expect(relayerHostNetwork('not a url')).toBeUndefined();
  });
});

describe('checkNetworkEnv', () => {
  it('refuses when no network is set, and never picks one', () => {
    const r = checkNetworkEnv({}, live);
    expect(r.network).toBeUndefined();
    expect(r.problems.join('\n')).toMatch(/no network is set/);
    // A relayer URL without WALRUS_NETWORK is refused even though its host is known: the host never sets the network.
    const r2 = checkNetworkEnv({ WALRUS_RELAYER_URL: MAIN, BUIRY_ALLOW_MAINNET: '1' }, live);
    expect(r2.network).toBeUndefined();
    expect(r2.problems.join('\n')).toMatch(/WALRUS_NETWORK is not set/);
  });

  it('needs TATUM_NETWORK whenever the chain gateway is configured', () => {
    const r = checkNetworkEnv({ WALRUS_NETWORK: 'testnet' }, live);
    expect(r.problems).toEqual([
      'TATUM_NETWORK is not set: the chain gateway is configured, so its network must be named',
    ]);
    expect(checkNetworkEnv({ WALRUS_NETWORK: 'testnet' }, { ...live, gatewayConfigured: false })).toEqual({
      network: 'testnet',
      problems: [],
    });
  });

  it('refuses a relayer host that disagrees with WALRUS_NETWORK or TATUM_NETWORK', () => {
    const r = checkNetworkEnv(
      { WALRUS_RELAYER_URL: MAIN, WALRUS_NETWORK: 'testnet', TATUM_NETWORK: 'testnet' },
      live,
    );
    expect(r.network).toBeUndefined();
    expect(r.problems.join('\n')).toContain(
      'networks disagree: WALRUS_NETWORK=testnet, TATUM_NETWORK=testnet, WALRUS_RELAYER_URL host relayer.memory.walrus.xyz=mainnet',
    );
    const r2 = checkNetworkEnv(
      { WALRUS_RELAYER_URL: STAGING, WALRUS_NETWORK: 'testnet', TATUM_NETWORK: 'mainnet' },
      live,
    );
    expect(r2.problems.join('\n')).toMatch(/networks disagree/);
  });

  it('checks every *_RELAYER_URL, so a testnet file carrying a mainnet account is refused', () => {
    const r = checkNetworkEnv(
      {
        WALRUS_RELAYER_URL: STAGING,
        BYO_A_RELAYER_URL: STAGING,
        BYO_B_RELAYER_URL: MAIN,
        WALRUS_NETWORK: 'testnet',
        TATUM_NETWORK: 'testnet',
      },
      live,
    );
    expect(r.problems.join('\n')).toContain('BYO_B_RELAYER_URL host relayer.memory.walrus.xyz=mainnet');
  });

  it('refuses an unrecognised relayer host unless WALRUS_RELAYER_NETWORK names its network', () => {
    const env = { WALRUS_RELAYER_URL: 'https://relayer.example.test', WALRUS_NETWORK: 'testnet' };
    const opts = { ...live, gatewayConfigured: false };
    expect(checkNetworkEnv(env, opts).problems.join('\n')).toMatch(
      /WALRUS_RELAYER_URL host relayer\.example\.test is not a hosted Walrus Memory relayer.*set WALRUS_RELAYER_NETWORK/,
    );
    expect(checkNetworkEnv({ ...env, WALRUS_RELAYER_NETWORK: 'testnet' }, opts)).toEqual({
      network: 'testnet',
      problems: [],
    });
    // The override is a statement about the relayer: it must agree with the rest too.
    expect(
      checkNetworkEnv(
        { ...env, WALRUS_RELAYER_NETWORK: 'mainnet', BUIRY_ALLOW_MAINNET: '1' },
        opts,
      ).problems.join(),
    ).toMatch(/networks disagree/);
    expect(checkNetworkEnv({ ...env, WALRUS_RELAYER_NETWORK: 'sepolia' }, opts).problems.join()).toMatch(
      /WALRUS_RELAYER_NETWORK=sepolia is not a Sui network/,
    );
  });

  it('refuses mainnet without BUIRY_ALLOW_MAINNET=1, and accepts it with the opt-in and matching values', () => {
    const env = { WALRUS_RELAYER_URL: MAIN, WALRUS_NETWORK: 'mainnet', TATUM_NETWORK: 'mainnet' };
    expect(checkNetworkEnv(env, live).problems).toEqual([
      'mainnet is refused without BUIRY_ALLOW_MAINNET=1 (an explicit opt-in)',
    ]);
    expect(checkNetworkEnv({ ...env, BUIRY_ALLOW_MAINNET: 'true' }, live).problems).toHaveLength(1);
    expect(checkNetworkEnv({ ...env, BUIRY_ALLOW_MAINNET: '1' }, live)).toEqual({
      network: 'mainnet',
      problems: [],
    });
    // The opt-in only permits mainnet; it never selects it.
    expect(checkNetworkEnv({ BUIRY_ALLOW_MAINNET: '1' }, live).network).toBeUndefined();
  });

  it('needs nothing when no live service is configured and no network is required (mock runs)', () => {
    expect(checkNetworkEnv({}, { requireNetwork: false, gatewayConfigured: false })).toEqual({
      problems: [],
    });
  });

  it('names variables and hosts only, never other values', () => {
    const r = checkNetworkEnv(
      {
        WALRUS_RELAYER_URL: 'https://user:pw-made-up-123@relayer.example.test/p?k=v',
        WALRUS_NETWORK: 'testnet',
      },
      { requireNetwork: true, gatewayConfigured: false },
    );
    const text = r.problems.join('\n');
    expect(text).toContain('relayer.example.test');
    expect(text).not.toContain('pw-made-up-123');
    expect(text).not.toContain('k=v');
  });
});
