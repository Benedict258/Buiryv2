import { describe, expect, it } from 'vitest';
import { checkNetworks, normalizeSuiNetwork, projectNetworkConflicts } from '../src/index.js';

describe('network consistency', () => {
  it('normalises mainnet, sui:testnet and case', () => {
    expect(normalizeSuiNetwork('mainnet')).toBe('mainnet');
    expect(normalizeSuiNetwork('sui:Testnet')).toBe('testnet');
    expect(normalizeSuiNetwork(' devnet ')).toBe('devnet');
    expect(normalizeSuiNetwork('eip155:1')).toBeUndefined();
  });

  it('agrees when every named source says the same network', () => {
    expect(
      checkNetworks({
        walrus: 'testnet',
        tatum: 'testnet',
        relayer: 'testnet',
        demo: 'sui:testnet',
        projects: [{ id: 'prj_1', networks: ['sui:testnet', 'eip155:1'] }],
      }),
    ).toEqual({ network: 'testnet', mismatches: [] });
  });

  it('names each source when they disagree (the case found live: Mainnet relayer, testnet labels)', () => {
    const r = checkNetworks({ walrus: 'testnet', tatum: 'testnet', relayer: 'mainnet' });
    expect(r.network).toBeUndefined();
    expect(r.mismatches).toEqual([
      'networks disagree: WALRUS_NETWORK=testnet, TATUM_NETWORK=testnet, relayer /config network=mainnet',
    ]);
  });

  it('flags DEMO_NETWORK against the rest', () => {
    expect(
      checkNetworks({ walrus: 'testnet', tatum: 'testnet', demo: 'sui:mainnet' }).mismatches[0],
    ).toContain('DEMO_NETWORK=mainnet');
  });

  it('rejects a value that is not a Sui network', () => {
    expect(checkNetworks({ tatum: 'sepolia' }).mismatches).toEqual([
      'TATUM_NETWORK=sepolia is not a Sui network (mainnet, testnet or devnet)',
    ]);
  });

  it('names a project that declares another Sui network, and ignores other chains', () => {
    const r = checkNetworks({
      walrus: 'testnet',
      projects: [
        { id: 'prj_ok', networks: ['sui:testnet', 'eip155:1'] },
        { id: 'prj_bad', networks: ['sui:mainnet'] },
      ],
    });
    expect(r.network).toBeUndefined();
    expect(r.mismatches).toEqual(['project prj_bad declares sui:mainnet but this deployment is on testnet']);
  });

  it('checks nothing when no source names a network', () => {
    expect(checkNetworks({ projects: [{ id: 'p', networks: ['sui:mainnet'] }] })).toEqual({ mismatches: [] });
  });

  it('lists a project network that conflicts with the deployment', () => {
    expect(projectNetworkConflicts(['sui:mainnet', 'eip155:1', 'sui:testnet'], 'testnet')).toEqual([
      'sui:mainnet',
    ]);
    expect(projectNetworkConflicts(['sui:mainnet'], undefined)).toEqual([]);
  });
});
