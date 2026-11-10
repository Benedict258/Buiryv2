import { afterEach, describe, expect, it } from 'vitest';
import { status } from '@grpc/grpc-js';
import {
  TatumGateway,
  checkNetworkSanity,
  simulateToFailure,
  verifyEvidence,
  verifyFunctionSignature,
  verifyWalrusHealth,
  type VerifyContext,
} from '../src/index.js';
import { ids, rig } from './helpers.js';

const open: Awaited<ReturnType<typeof rig>>[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});
async function ctxFor(o: Parameters<typeof rig>[0] = {}, declared = ['sui:mainnet']) {
  const r = await rig(o);
  open.push(r);
  const ctx: VerifyContext = { gateway: r.gateway, declaredNetworks: declared };
  return { ...r, ctx };
}

describe('transaction verifier', () => {
  it('passes a successful publish and extracts package and object evidence', async () => {
    const { ctx } = await ctxFor();
    const out = await verifyEvidence({ kind: 'tx', digest: ids.D_PUBLISH, network: 'sui:mainnet' }, ctx);
    expect(out.result).toBe('pass');
    expect(out.extracted).toEqual([
      { kind: 'package', id: ids.PKG_V3, network: 'sui:mainnet' },
      { kind: 'object', id: ids.OBJ_REG, version: '5', network: 'sui:mainnet' },
      { kind: 'object', id: ids.OBJ_CAP, version: '5', network: 'sui:mainnet' },
    ]);
    expect(out.observed).toMatchObject({ checkpoint: '51234567', created: 3 });
  });

  it('fails a transaction that failed on chain', async () => {
    const { ctx } = await ctxFor();
    const out = await verifyEvidence({ kind: 'tx', digest: ids.D_FAILED, network: 'sui:mainnet' }, ctx);
    expect(out).toMatchObject({ result: 'fail' });
    expect(out.detail).toMatch(/MoveAbort/);
  });

  it('reports pruned or unknown history as unknown, never false', async () => {
    const { ctx } = await ctxFor();
    const out = await verifyEvidence({ kind: 'tx', digest: ids.D_PRUNED, network: 'sui:mainnet' }, ctx);
    expect(out.result).toBe('unknown');
    expect(out.detail).toMatch(/older than the node retains|not found/);
  });

  it('flags a digest that belongs to another network', async () => {
    const { ctx } = await ctxFor();
    const out = await verifyEvidence({ kind: 'tx', digest: ids.D_TESTNET, network: 'sui:mainnet' }, ctx);
    expect(out).toMatchObject({ result: 'fail', observed: { foundOn: ['sui:testnet'] } });
  });
});

describe('object verifier (drift)', () => {
  it('passes when the cited version is current', async () => {
    const { ctx } = await ctxFor();
    expect(
      (await verifyEvidence({ kind: 'object', id: ids.OBJ_REG, version: '7', network: 'sui:mainnet' }, ctx))
        .result,
    ).toBe('pass');
    expect(
      (await verifyEvidence({ kind: 'object', id: ids.OBJ_REG, network: 'sui:mainnet' }, ctx)).result,
    ).toBe('pass');
  });
  it('fails on version drift with expected vs observed', async () => {
    const { ctx } = await ctxFor();
    const out = await verifyEvidence(
      { kind: 'object', id: ids.OBJ_REG, version: '5', network: 'sui:mainnet' },
      ctx,
    );
    expect(out).toMatchObject({ result: 'fail', observed: { expectedVersion: '5', observedVersion: '7' } });
  });
  it('fails when the object is gone, and normalises short ids', async () => {
    const { ctx } = await ctxFor();
    expect(
      (await verifyEvidence({ kind: 'object', id: '0x' + 'ee'.repeat(32), network: 'sui:mainnet' }, ctx))
        .result,
    ).toBe('fail');
    const short = ids.OBJ_REG.replace(/^0x0*/, '0x');
    expect(
      (await verifyEvidence({ kind: 'object', id: short, version: '7', network: 'sui:mainnet' }, ctx)).result,
    ).toBe('pass');
  });
  it('detects an object that exists only on another network', async () => {
    const { ctx } = await ctxFor();
    const out = await verifyEvidence({ kind: 'object', id: ids.OBJ_TESTONLY, network: 'sui:mainnet' }, ctx);
    expect(out).toMatchObject({ result: 'fail', observed: { foundOn: ['sui:testnet'] } });
  });
});

describe('package verifier (upgrade detection)', () => {
  it('fails when a newer version exists', async () => {
    const { ctx } = await ctxFor();
    const out = await verifyEvidence({ kind: 'package', id: ids.PKG_V3, network: 'sui:mainnet' }, ctx);
    expect(out).toMatchObject({
      result: 'fail',
      observed: { citedVersion: '3', latestVersion: '4', latestPackageId: ids.PKG_V4 },
    });
  });
  it('passes at the latest version', async () => {
    const { ctx } = await ctxFor();
    expect(
      (await verifyEvidence({ kind: 'package', id: ids.PKG_V4, network: 'sui:mainnet' }, ctx)).result,
    ).toBe('pass');
  });
  it('unknown when the package is not found anywhere; fail when it lives on another network', async () => {
    const { ctx } = await ctxFor();
    expect(
      (await verifyEvidence({ kind: 'package', id: '0x' + 'f0'.repeat(32), network: 'sui:mainnet' }, ctx))
        .result,
    ).toBe('unknown');
    expect(
      (await verifyEvidence({ kind: 'package', id: ids.TPKG, network: 'sui:mainnet' }, ctx)).observed,
    ).toMatchObject({ foundOn: ['sui:testnet'] });
  });
  it('is unknown (not fail) when only JSON-RPC is available, since version history is gRPC-only', async () => {
    const { ctx } = await ctxFor({ grpc: false, jsonrpc: true });
    const out = await verifyEvidence({ kind: 'package', id: ids.PKG_V3, network: 'sui:mainnet' }, ctx);
    expect(out).toMatchObject({ result: 'unknown', degraded: true });
  });
  it('checks function signature drift', async () => {
    const { ctx } = await ctxFor();
    expect(
      (
        await verifyFunctionSignature(
          ids.PKG_V4,
          'registry',
          'register',
          { parameterCount: 3 },
          'sui:mainnet',
          ctx,
        )
      ).result,
    ).toBe('pass');
    expect(
      (
        await verifyFunctionSignature(
          ids.PKG_V4,
          'registry',
          'register',
          { parameterCount: 2 },
          'sui:mainnet',
          ctx,
        )
      ).result,
    ).toBe('fail');
  });
});

describe('simulation to failure memory', () => {
  it('turns a failed simulation into a proposed failure draft', async () => {
    const { ctx } = await ctxFor();
    const out = await simulateToFailure({ bcsBase64: 'AAEC' }, 'sui:mainnet', ctx, 'migration batch');
    expect(out.result).toBe('fail');
    expect(out.failureDraft).toMatchObject({ type: 'failure', evidence: [] });
    expect(out.failureDraft!.text).toMatch(
      /Simulation of migration batch failed on sui:mainnet: InsufficientGas.*INSUFFICIENT_GAS.*command 2/,
    );
  });
});

describe('degradation: an outage never marks anything stale', () => {
  const evidence = [
    { kind: 'tx' as const, digest: ids.D_PUBLISH, network: 'sui:mainnet' },
    { kind: 'object' as const, id: ids.OBJ_REG, version: '5', network: 'sui:mainnet' },
    { kind: 'package' as const, id: ids.PKG_V3, network: 'sui:mainnet' },
  ];
  it('gateway unavailable -> unknown + degraded for every verifier', async () => {
    const { ctx, mainnet } = await ctxFor();
    mainnet.failNext(1000);
    for (const ev of evidence) {
      const out = await verifyEvidence(ev, ctx);
      expect(out.result, ev.kind).toBe('unknown');
      expect(out.degraded, ev.kind).toBe(true);
    }
  });
  it('an expired cached pass is not reused when gRPC goes down (gRPC only, no stale pass)', async () => {
    const { ctx, mainnet, clock } = await ctxFor();
    const ev = { kind: 'object' as const, id: ids.OBJ_REG, network: 'sui:mainnet' };
    const first = await verifyEvidence(ev, ctx);
    expect(first.result).toBe('pass');
    clock.t += 5 * 60_000; // well past the 60 s cache lifetime of a current-object read
    mainnet.failNext(1000, status.UNAVAILABLE);
    const out = await verifyEvidence(ev, ctx);
    expect(out).toMatchObject({ result: 'unknown', degraded: true });
  });
  it('bad API key -> unknown with a configuration message', async () => {
    const { ctx } = await ctxFor({ apiKey: 'wrong' });
    const out = await verifyEvidence(evidence[1]!, ctx);
    expect(out).toMatchObject({ result: 'unknown', degraded: true });
    expect(out.detail).toMatch(/API key/);
  });
  it('credit budget exhausted -> unknown', async () => {
    const { ctx } = await ctxFor({ gateway: { workspaceCredits: { limit: 0, periodMs: 1000 } } });
    const out = await verifyEvidence(evidence[0]!, { ...ctx, workspaceId: 'wsp_a' });
    expect(out).toMatchObject({ result: 'unknown', degraded: true });
    expect(out.detail).toMatch(/budget/);
  });
  it('rate limiting from the gateway -> unknown', async () => {
    const { ctx, mainnet } = await ctxFor();
    mainnet.failNext(1000, status.RESOURCE_EXHAUSTED);
    expect((await verifyEvidence(evidence[0]!, ctx)).degraded).toBe(true);
  });
  it('network sanity returns unknown during an outage', async () => {
    const { ctx, mainnet } = await ctxFor();
    mainnet.failNext(1000);
    expect((await checkNetworkSanity(ids.OBJ_REG, 'object', ctx)).result).toBe('unknown');
  });
});

describe('network sanity', () => {
  it('passes on the declared network and fails when the id is on another network', async () => {
    const { ctx } = await ctxFor();
    expect((await checkNetworkSanity(ids.OBJ_REG, 'object', ctx)).result).toBe('pass');
    expect(await checkNetworkSanity(ids.OBJ_TESTONLY, 'object', ctx)).toMatchObject({
      result: 'fail',
      observed: { foundOn: ['sui:testnet'] },
    });
    expect((await checkNetworkSanity('0x' + 'dd'.repeat(32), 'object', ctx)).result).toBe('unknown');
  });
});

describe('repository evidence (computed client-side)', () => {
  const ev = { kind: 'file' as const, path: 'packages/api/package.json', commit: 'a1b2c3d' };
  it('passes, fails on change, fails on removal, unknown without a result', async () => {
    const { ctx } = await ctxFor();
    const run = (repo?: VerifyContext['repo']) => verifyEvidence(ev, { ...ctx, ...(repo ? { repo } : {}) });
    expect((await run({ [ev.path]: { exists: true, changed: false } })).result).toBe('pass');
    expect((await run({ [ev.path]: { exists: true, changed: true, currentCommit: 'ffff' } })).detail).toMatch(
      /changed since a1b2c3d/,
    );
    expect((await run({ [ev.path]: { exists: false, changed: true } })).result).toBe('fail');
    expect((await run()).result).toBe('unknown');
  });
  it('has no verifier for urls or tests (not checkable)', async () => {
    const { ctx } = await ctxFor();
    expect((await verifyEvidence({ kind: 'url', href: 'https://example.com' }, ctx)).result).toBe('unknown');
  });
});

describe('minimal EVM verifier', () => {
  const evmGateway = (responses: Record<string, unknown>) =>
    new TatumGateway({
      backends: { 'sui:mainnet': [] },
      defaultNetwork: 'sui:mainnet',
      evm: { 'ethereum-mainnet': { url: 'http://evm.test', apiKey: 'k' } },
      sleep: async () => {},
      evmFetch: (async (_u: unknown, init: { body: string }) => {
        const { method } = JSON.parse(init.body) as { method: string };
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: responses[method] ?? null }), {
          status: 200,
        });
      }) as unknown as typeof fetch,
    });
  it('checks receipt status and contract code', async () => {
    const ok: VerifyContext = {
      gateway: evmGateway({ eth_getTransactionReceipt: { status: '0x1' }, eth_getCode: '0x6080' }),
      declaredNetworks: [],
    };
    expect(
      (await verifyEvidence({ kind: 'tx', digest: '0xabc', network: 'evm:ethereum-mainnet' }, ok)).result,
    ).toBe('pass');
    expect(
      (await verifyEvidence({ kind: 'package', id: '0xdef', network: 'evm:ethereum-mainnet' }, ok)).result,
    ).toBe('pass');
    const bad: VerifyContext = {
      gateway: evmGateway({ eth_getTransactionReceipt: { status: '0x0' }, eth_getCode: '0x' }),
      declaredNetworks: [],
    };
    expect(
      (await verifyEvidence({ kind: 'tx', digest: '0xabc', network: 'evm:ethereum-mainnet' }, bad)).result,
    ).toBe('fail');
    expect(
      (await verifyEvidence({ kind: 'package', id: '0xdef', network: 'evm:ethereum-mainnet' }, bad)).result,
    ).toBe('fail');
    const none: VerifyContext = { gateway: evmGateway({}), declaredNetworks: [] };
    expect(
      (await verifyEvidence({ kind: 'tx', digest: '0xabc', network: 'evm:ethereum-mainnet' }, none)).result,
    ).toBe('unknown');
    expect(
      (await verifyEvidence({ kind: 'tx', digest: '0xabc', network: 'evm:unconfigured' }, none)).result,
    ).toBe('unknown');
  });
});

describe('Walrus health verifier (read-interface expiry + chain cross-check)', () => {
  it('flags expiring and expired memories against the on-chain epoch (800)', async () => {
    const { ctx } = await ctxFor();
    const out = await verifyWalrusHealth(
      {
        network: 'sui:mainnet',
        accountId: ids.OBJ_REG,
        items: [
          { memoryId: 'mem_ok', blobId: 'b1', endEpoch: 810, status: 'active' },
          { memoryId: 'mem_soon', blobId: 'b2', endEpoch: 801, status: 'active' },
          { memoryId: 'mem_gone', blobId: 'b3', endEpoch: 799, status: 'expired' },
          { memoryId: 'mem_lying', blobId: 'b4', endEpoch: 800, status: 'active' },
        ],
      },
      ctx,
    );
    expect(out.expiring).toEqual(['mem_soon']);
    expect(out.expired).toEqual(['mem_gone', 'mem_lying']);
    expect(out.inconsistent).toEqual(['mem_lying']);
    expect(out.result).toBe('fail');
  });
  it('passes when healthy; warns detail when inside the margin; fails on unexpected delegates or missing account', async () => {
    const { ctx } = await ctxFor();
    const healthy = await verifyWalrusHealth(
      { network: 'sui:mainnet', items: [{ memoryId: 'm', blobId: 'b', endEpoch: 900 }] },
      ctx,
    );
    expect(healthy).toMatchObject({ result: 'pass', detail: 'storage healthy' });
    const soon = await verifyWalrusHealth(
      { network: 'sui:mainnet', items: [{ memoryId: 'm', blobId: 'b', endEpoch: 801 }] },
      ctx,
    );
    expect(soon).toMatchObject({ result: 'pass', expiring: ['m'] });
    const del = await verifyWalrusHealth(
      { network: 'sui:mainnet', items: [], expectedDelegates: ['aa'], observedDelegates: ['aa', 'evil'] },
      ctx,
    );
    expect(del).toMatchObject({ result: 'fail', unexpectedDelegates: ['evil'] });
    const missing = await verifyWalrusHealth(
      { network: 'sui:mainnet', accountId: '0x' + 'ee'.repeat(32), items: [] },
      ctx,
    );
    expect(missing.result).toBe('fail');
  });
  it('is unknown during a gateway outage', async () => {
    const { ctx, mainnet } = await ctxFor();
    mainnet.failNext(1000);
    const out = await verifyWalrusHealth(
      { network: 'sui:mainnet', items: [{ memoryId: 'm', blobId: 'b', endEpoch: 1 }] },
      ctx,
    );
    expect(out).toMatchObject({ result: 'unknown', degraded: true, expired: [] });
  });
});
