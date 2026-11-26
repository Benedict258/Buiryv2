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

// Phase 14b B: every live script prints errors through errorText (class, kind, status, cause), never an error message,
// and its own refusals as ScriptRefusal.
describe.each([
  ['canary', './canary.ts'],
  ['recall-calibrate', './recall-calibrate.ts'],
  ['byo-isolation', './byo-isolation.ts'],
  ['byo-live', '../byo-live.ts'],
  ['handoff-proof', './handoff-proof.ts'],
])('%s error output', (_who, rel) => {
  const body = code(read(rel));
  it('never prints an error message, and its last-resort catch prints errorText', () => {
    expect(body).not.toMatch(/\(e as Error\)\.(message|name)/);
    expect(body).not.toMatch(/\be\.message|String\(e\)/);
    expect(body).not.toMatch(/throw new Error\(/);
    expect(body).toMatch(/\} catch \(e\) \{\s+[^\n]*errorText\(e\)/);
  });
});

describe('canary /config check (Phase 14b)', () => {
  const body = code(read('./canary.ts'));
  it('still fails closed on another network, through relayerNetworkProblem', () => {
    expect(body).toMatch(
      /const wrongNetwork = relayerNetworkProblem\(conf\.network, pre\.network\);\s+if \(wrongNetwork\) throw new ScriptRefusal\(wrongNetwork\);/,
    );
    expect(body).toMatch(/errorText\(e\)/);
  });
});

describe('handoff-proof server errors (Phase 14b)', () => {
  const body = code(read('./handoff-proof.ts'));
  it("prints the server's error code only when it is a plain code, with the HTTP status", () => {
    expect(body).toContain("/^[a-z_]{1,40}$/.test(j.error.code) ? j.error.code : ''");
    expect(body).toContain('HTTP ${res.status} ${code}');
    expect(body).not.toContain('j.error?.code ??');
  });
});

// Phase 14c: both two-account scripts take the stack's network and mainnet opt-in from applyLiveNetwork (behaviour
// tested in scripts/lib/own-account-setup.test.ts), never by setting them directly.
describe.each([
  ['byo-isolation', './byo-isolation.ts'],
  ['byo-live', '../byo-live.ts'],
])('%s stack network', (_who, rel) => {
  const body = code(read(rel));
  it('calls applyLiveNetwork once, after the network guard, and never sets allowMainnet or the network itself', () => {
    expect(body.match(/applyLiveNetwork\(s\.deps, network, env\);/g)).toHaveLength(1);
    expect(body.indexOf('applyLiveNetwork(s.deps')).toBeGreaterThan(body.indexOf('requireLiveNetwork(env'));
    expect(body).not.toMatch(/allowMainnet\s*=/);
    expect(body).not.toMatch(/deps\.networks\s*=/);
  });
});
