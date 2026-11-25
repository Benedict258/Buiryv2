import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Phase 14 A: the isolation run, the own-account check and the handoff proof run on either network with the canary's
// guards. Source-shape checks only: these scripts are never run by the tests.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const code = (src: string) =>
  src
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\*\*|\/\/)/.test(l))
    .join('\n');
const CONNECTS = [
  'new HttpWalrusAdapter(',
  'buildWalrusAdapter(',
  'createGatewayIfConfigured(',
  'createStack(',
  'fetch(',
];

describe.each([
  ['byo-isolation', './byo-isolation.ts', 1],
  ['byo-live', '../byo-live.ts', 2],
])('%s', (who, rel, writes) => {
  const src = read(rel);
  const body = code(src);

  it('checks both accounts and the network before anything connects, and prints the network first', () => {
    const accounts = body.indexOf('twoAccountProblems(env)');
    const guard = body.indexOf(
      `requireLiveNetwork(env, '${who}', ['BYO_A_RELAYER_URL', 'BYO_B_RELAYER_URL'])`,
    );
    expect(accounts).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(accounts);
    for (const c of CONNECTS) {
      const at = body.indexOf(c);
      if (at >= 0) expect(at, c).toBeGreaterThan(guard);
    }
    expect(body.slice(0, guard)).not.toMatch(/console\.log\(/);
  });

  it('compares each relayer /config network and the two owner wallets before the first write', () => {
    const owner = body.indexOf('.ownerAddress()');
    const wallet = body.indexOf('sameWalletProblem(');
    const firstWrite = body.indexOf('.remember(');
    expect(owner).toBeGreaterThan(0);
    expect(wallet).toBeGreaterThan(owner);
    expect(body).toMatch(/relayerNetworkProblem\(\(await a\.relayerConfig\(\)\)\.network, network\)/);
    if (who === 'byo-isolation')
      expect(body).toMatch(/await accountsPreflight\(\);\s+const tA = await tester\('A'\)/);
    else expect(wallet).toBeLessThan(firstWrite);
  });

  it('assumes no network: no testnet or mainnet literal in code, and the write count is unchanged', () => {
    expect(body).not.toMatch(/'(sui:)?(testnet|mainnet)'/);
    expect(body).not.toMatch(
      /requireLiveTestnet|WALRUS_BYO_TEST_|PROOF_(RELAYER_URL|ACCOUNT_ID|DELEGATE_KEY)/,
    );
    expect(body.match(/\.remember\(/g)).toHaveLength(writes);
  });
});

describe('handoff-proof', () => {
  const body = code(read('./handoff-proof.ts'));
  it('runs the network guard for every step that reaches a server, relayer or chain, never defaulting a network', () => {
    expect(body).toMatch(
      /cmd === 'prepare' \|\| cmd === 'collect' \|\| cmd === 'verify-chain' \|\| cmd === 'scores'\)\s+checkedNetwork = requireLiveNetwork\(env, 'handoff-proof', \['BYO_A_RELAYER_URL'\]\)/,
    );
    expect(body).toMatch(/let checkedNetwork: 'testnet' \| 'mainnet' \| undefined;/);
    expect(body).not.toMatch(/=== 'testnet'|!== 'testnet'|requireLiveTestnet/);
  });
  it('saves the network at prepare and refuses a later step on another network', () => {
    expect(body).toMatch(/network: liveNet\(\),/);
    expect(body.match(/sameNetworkAsPrepared\(meta\);/g)).toHaveLength(3);
    expect(body).toMatch(/relayerNetworkProblem\(conf\.network, liveNet\(\)\)/);
  });
  it('uses tester A (BYO_A_*) as the proof account and writes nothing itself', () => {
    expect(body).not.toMatch(/PROOF_(RELAYER_URL|ACCOUNT_ID|DELEGATE_KEY)/);
    expect(body).toContain('env.BYO_A_DELEGATE_KEY!');
    expect(body).not.toMatch(/\.remember\(/);
  });
});
