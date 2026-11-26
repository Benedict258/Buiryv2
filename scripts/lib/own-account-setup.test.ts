import { afterEach, describe, expect, it } from 'vitest';
import { createStack } from '../../packages/api/src/index.js';
import { BuiryError } from '../../packages/core/src/index.js';
import { ScriptRefusal } from './errors.js';
import { applyLiveNetwork, setUpTester } from './own-account-setup.js';

// Phase 14c: behaviour, not source shape. The isolation run's tester setup (workspace, project, setProjectStorage) runs
// against an in-process stack (PGlite) with mainnet settings. The relayer probe and DNS are stubbed: nothing leaves the
// process. Every account id and key is MADE UP.

const MAIN = 'https://relayer.memory.walrus.xyz';
const KEY_A = 'a1'.repeat(32);
const ACCOUNT_A = '0x' + 'a'.repeat(64);
const mainnetEnv = (optIn: boolean): Record<string, string> => ({
  WALRUS_NETWORK: 'mainnet',
  TATUM_NETWORK: 'mainnet',
  BYO_A_RELAYER_URL: MAIN,
  BYO_A_ACCOUNT_ID: ACCOUNT_A,
  BYO_A_DELEGATE_KEY: KEY_A,
  ...(optIn ? { BUIRY_ALLOW_MAINNET: '1' } : {}),
});
const stubs = {
  probe: async () => ({ network: 'mainnet', packageId: '0xmadeup' }),
  resolve: async () => ['93.184.216.34'],
};

let stack: Awaited<ReturnType<typeof createStack>> | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

describe('isolation tester setup on mainnet (behaviour)', () => {
  it('(a) connects the own account with the verified opt-in', async () => {
    stack = await createStack();
    const env = mainnetEnv(true);
    applyLiveNetwork(stack.deps, 'mainnet', env);
    expect(stack.deps.allowMainnet).toBe(true);
    expect(stack.deps.networks).toEqual({ sui: 'mainnet' });
    const t = await setUpTester(stack, { side: 'A', run: 'abc123', network: 'mainnet', env, ...stubs });
    expect(t.view.accountId).toBe(ACCOUNT_A);
    expect(t.view.network).toBe('mainnet');
  });

  it('(b) still refuses a mainnet account without the opt-in', async () => {
    stack = await createStack();
    const env = mainnetEnv(false);
    applyLiveNetwork(stack.deps, 'mainnet', env);
    expect(stack.deps.allowMainnet).toBe(false);
    const err = await setUpTester(stack, {
      side: 'A',
      run: 'abc123',
      network: 'mainnet',
      env,
      ...stubs,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BuiryError);
    expect((err as BuiryError).code).toBe('invalid_input');
  });

  it('(c) refuses any network other than testnet or mainnet before the stack is changed', async () => {
    stack = await createStack();
    const before = { ...stack.deps };
    expect(() =>
      applyLiveNetwork(stack!.deps, 'devnet', { ...mainnetEnv(true), WALRUS_NETWORK: 'devnet' }),
    ).toThrow(ScriptRefusal);
    expect(() => applyLiveNetwork(stack!.deps, 'sepolia', mainnetEnv(true))).toThrow(
      /live runs use testnet or mainnet; the settings name an unrecognised network/,
    );
    expect(stack.deps.networks).toEqual(before.networks);
    expect(stack.deps.allowMainnet).toEqual(before.allowMainnet);
  });

  it('keeps testnet unchanged: no mainnet opt-in on the stack, and a testnet account connects', async () => {
    stack = await createStack();
    const env = {
      WALRUS_NETWORK: 'testnet',
      BYO_A_RELAYER_URL: 'https://relayer.dev.memwal.ai',
      BYO_A_ACCOUNT_ID: ACCOUNT_A,
      BYO_A_DELEGATE_KEY: KEY_A,
    };
    applyLiveNetwork(stack.deps, 'testnet', env);
    expect(stack.deps.allowMainnet).toBe(false);
    const t = await setUpTester(stack, {
      side: 'A',
      run: 'abc123',
      network: 'testnet',
      env,
      probe: async () => ({ network: 'testnet', packageId: '0xmadeup' }),
      resolve: stubs.resolve,
    });
    expect(t.view.network).toBe('testnet');
  });

  it('never sets the mainnet opt-in from the network alone', async () => {
    stack = await createStack();
    applyLiveNetwork(stack.deps, 'mainnet', { ...mainnetEnv(false), BUIRY_ALLOW_MAINNET: 'true' });
    expect(stack.deps.allowMainnet).toBe(false);
  });
});
