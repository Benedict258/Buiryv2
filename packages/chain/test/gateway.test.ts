import { afterEach, describe, expect, it } from 'vitest';
import { status } from '@grpc/grpc-js';
import { ChainError } from '../src/index.js';
import { ids, rig } from './helpers.js';

const open: Awaited<ReturnType<typeof rig>>[] = [];
const make = async (...a: Parameters<typeof rig>) => {
  const r = await rig(...a);
  open.push(r);
  return r;
};
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

describe('gateway over real gRPC (MockTatum)', () => {
  it('reads a transaction, maps u64 strings and changed objects, and records provenance', async () => {
    const { gateway, records } = await make();
    const r = await gateway.getTransaction(ids.D_PUBLISH);
    expect(r.prov).toMatchObject({ transport: 'grpc', network: 'sui:mainnet', cached: false });
    const tx = r.value!;
    expect(tx).toMatchObject({ digest: ids.D_PUBLISH, success: true, checkpoint: '51234567', epoch: '800' });
    expect(tx.timestampMs).toBe(1_792_000_000_000);
    expect(
      tx.changed
        .filter((c) => c.idOperation === 'created' && c.outputKind === 'package')
        .map((c) => c.objectId),
    ).toEqual([ids.PKG_V3]);
    expect(records).toEqual([
      expect.objectContaining({
        method: 'getTransaction',
        transport: 'grpc',
        status: 'ok',
        creditEstimate: 2,
        network: 'sui:mainnet',
      }),
    ]);
  });

  it('caches immutable data forever and de-duplicates concurrent identical calls', async () => {
    const { gateway, mainnet, clock } = await make();
    await Promise.all([1, 2, 3, 4, 5].map(() => gateway.getTransaction(ids.D_PUBLISH)));
    expect(mainnet.count('grpc', 'GetTransaction')).toBe(1);
    clock.t += 365 * 86_400_000;
    const again = await gateway.getTransaction(ids.D_PUBLISH);
    expect(again.prov).toMatchObject({ transport: 'cache', cached: true });
    expect(mainnet.count('grpc', 'GetTransaction')).toBe(1);
  });

  it('caches current state briefly (60s) and negative results very briefly (5s)', async () => {
    const { gateway, mainnet, clock } = await make();
    await gateway.getObject(ids.OBJ_REG);
    await gateway.getObject(ids.OBJ_REG);
    expect(mainnet.count('grpc', 'GetObject')).toBe(1);
    clock.t += 61_000;
    await gateway.getObject(ids.OBJ_REG);
    expect(mainnet.count('grpc', 'GetObject')).toBe(2);

    const missing = '0x' + 'ee'.repeat(32);
    expect((await gateway.getObject(missing)).value).toMatchObject({ found: false });
    await gateway.getObject(missing);
    expect(mainnet.count('grpc', 'GetObject')).toBe(3);
    clock.t += 6_000;
    await gateway.getObject(missing);
    expect(mainnet.count('grpc', 'GetObject')).toBe(4);
  });

  it('treats gRPC code 5 as absence (null), not an error', async () => {
    const { gateway } = await make();
    expect((await gateway.getTransaction(ids.D_PRUNED)).value).toBeNull();
    expect((await gateway.getTransaction('nope')).value).toBeNull();
  });

  it('maps code 16 to a config error, never retries it, and does not fall back', async () => {
    const { gateway, mainnet } = await make({ apiKey: 'wrong-key' });
    const e = (await gateway.getObject(ids.OBJ_REG).catch((x) => x)) as ChainError;
    expect(e).toBeInstanceOf(ChainError);
    expect(e.kind).toBe('config');
    expect(e.retryable).toBe(false);
    expect(mainnet.count('grpc')).toBe(1);
    expect(mainnet.count('jsonrpc')).toBe(0);
  });

  it('retries code 14 with backoff, then falls back to JSON-RPC on mainnet and records both attempts', async () => {
    const { gateway, mainnet, records, clock } = await make();
    mainnet.failNext(3, status.UNAVAILABLE, 503); // 3 gRPC attempts fail; JSON-RPC call is the 4th request
    const t0 = clock.t;
    const r = await gateway.getObject(ids.OBJ_REG);
    // the failure counter is shared across transports; clear it so the JSON-RPC call succeeds
    expect(r.value.found).toBe(true);
    expect(r.prov.transport).toBe('jsonrpc');
    expect(mainnet.count('grpc', 'GetObject')).toBe(3);
    expect(clock.t - t0).toBeGreaterThanOrEqual(250 + 500); // exponential backoff 250, 500
    const rows = records.filter((x) => x.method === 'getObject');
    expect(rows.map((x) => [x.transport, x.status])).toEqual([
      ['grpc', 'error'],
      ['grpc', 'error'],
      ['grpc', 'error'],
      ['jsonrpc', 'ok'],
    ]);
    expect(rows[3]!.fallbackFrom).toBe('grpc');
    expect(rows[0]!.errorKind).toBe('unavailable');
  });

  it('reports degraded after consecutive failures and recovers on success', async () => {
    const { gateway, mainnet } = await make({ jsonrpc: false });
    mainnet.failNext(100);
    for (let i = 0; i < 2; i++) await gateway.getObject(ids.OBJ_REG).catch(() => {});
    expect(gateway.status().state).toBe('degraded');
    mainnet.clearFailures();
    await gateway.getTransaction(ids.D_PUBLISH);
    expect(gateway.status()).toMatchObject({ state: 'ok', consecutiveFailures: 0 });
  });

  it('enforces the 3 requests/second token bucket across calls', async () => {
    const { gateway, clock } = await make();
    const t0 = clock.t;
    for (let i = 0; i < 12; i++) await gateway.getObject('0x' + i.toString(16).padStart(64, '0')); // distinct, uncached
    // burst of 3 free, then 9 more at 3/s => about 3 seconds of waiting
    expect(clock.t - t0).toBeGreaterThanOrEqual(2900);
    expect(clock.slept).toBeLessThan(4500);
  });

  it('enforces a per-workspace credit budget (2 credits per uncached call) without hurting other workspaces', async () => {
    const { gateway } = await make({ gateway: { workspaceCredits: { limit: 6, periodMs: 3_600_000 } } });
    for (let i = 0; i < 3; i++)
      await gateway.getObject('0x' + (i + 1).toString(16).padStart(64, '0'), { workspaceId: 'wsp_a' });
    const e = (await gateway
      .getObject('0x' + 'ab'.repeat(32), { workspaceId: 'wsp_a' })
      .catch((x) => x)) as ChainError;
    expect(e.kind).toBe('budget_exceeded');
    await expect(gateway.getObject('0x' + 'cd'.repeat(32), { workspaceId: 'wsp_b' })).resolves.toBeTruthy();
    expect(gateway.creditUsage('wsp_a')).toEqual({ used: 6, limit: 6 });
    // cache hits are free
    await expect(
      gateway.getObject('0x' + (1).toString(16).padStart(64, '0'), { workspaceId: 'wsp_a' }),
    ).resolves.toBeTruthy();
  });

  it('batches uncached objects into BatchGetObjects calls of at most 50 and serves repeats from cache', async () => {
    const { gateway, mainnet } = await make();
    const idsList = [
      ids.OBJ_REG,
      ...Array.from({ length: 119 }, (_, i) => '0x' + (i + 100).toString(16).padStart(64, '0')),
    ];
    const r = await gateway.batchGetObjects(idsList);
    expect(mainnet.count('grpc', 'BatchGetObjects')).toBe(3);
    expect(r.value).toHaveLength(120);
    expect(r.value[0]).toMatchObject({ found: true });
    expect(r.value[1]).toMatchObject({ found: false });
    const again = await gateway.batchGetObjects(idsList);
    expect(mainnet.count('grpc', 'BatchGetObjects')).toBe(3);
    expect(again.prov.cached).toBe(true);
  });

  it('exposes package versions, functions, names, balances, owned objects, epoch and simulation', async () => {
    const { gateway } = await make();
    expect((await gateway.listPackageVersions(ids.PKG_V3)).value?.map((v) => v.version)).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
    expect((await gateway.listPackageVersions('0x' + 'f0'.repeat(32))).value).toBeNull();
    expect((await gateway.getFunction(ids.PKG_V4, 'registry', 'register')).value).toMatchObject({
      name: 'register',
      isEntry: true,
      parameterCount: 3,
    });
    expect((await gateway.lookupName('orbit.sui')).value?.targetAddress).toMatch(/^0x0b17/);
    const owner = '0x0b17' + '0'.repeat(56) + '0001';
    expect((await gateway.getBalance(owner, '0x2::sui::SUI')).value).toEqual({ balance: '1500000000' });
    expect((await gateway.listOwnedObjects(owner, undefined)).value).toEqual([
      { id: ids.OBJ_CAP, version: '5', type: '0x2::package::UpgradeCap' },
    ]);
    expect((await gateway.getEpoch()).value.epoch).toBe('800');
    expect((await gateway.getServiceInfo()).value).toMatchObject({
      chainId: '35834a8a',
      lowestAvailableCheckpoint: '51000000',
    });
    const sim = (await gateway.simulate({ bcsBase64: 'AAEC' })).value;
    expect(sim).toMatchObject({ success: false, error: { kind: 'INSUFFICIENT_GAS' } });
  });

  it('is gRPC-first on testnet too, and rejects unconfigured networks', async () => {
    const { gateway } = await make();
    expect((await gateway.getTransaction(ids.D_TESTNET, { network: 'sui:testnet' })).prov.transport).toBe(
      'grpc',
    );
    await expect(gateway.getTransaction('x', { network: 'sui:devnet' })).rejects.toMatchObject({
      kind: 'invalid',
    });
  });

  it('serves the JSON-RPC subset when gRPC is not configured, and reports gRPC-only methods as unsupported', async () => {
    const { gateway } = await make({ grpc: false });
    const tx = await gateway.getTransaction(ids.D_PUBLISH);
    expect(tx.prov.transport).toBe('jsonrpc');
    expect(tx.value!.changed.some((c) => c.outputKind === 'package' && c.objectId === ids.PKG_V3)).toBe(true);
    const o = await gateway.getObject(ids.OBJ_REG);
    expect(o.value).toMatchObject({ found: true, object: { version: '7' } });
    expect((await gateway.getObject('0x' + 'ee'.repeat(32))).value.found).toBe(false);
    await expect(gateway.listPackageVersions(ids.PKG_V3)).rejects.toMatchObject({ kind: 'unsupported' });
  });

  it('summarises transport mix, latency and credits for the verification panel', async () => {
    const { gateway } = await make();
    await gateway.getTransaction(ids.D_PUBLISH);
    await gateway.getTransaction(ids.D_PUBLISH);
    await gateway.getObject(ids.OBJ_REG);
    const s = gateway.status();
    expect(s.transportMix).toEqual({ grpc: 2, jsonrpc: 0, cache: 1 });
    expect(s.creditsEstimated).toBe(4);
    expect(s.errorRate).toBe(0);
    expect(s.lastSuccessAt).toBeDefined();
  });
});
