import { afterEach, describe, expect, it } from 'vitest';
import {
  buildRuntime,
  checkRuntimeNetworks,
  createStack,
  systemPrincipal,
  type Stack,
} from '../src/index.js';

const open: Stack[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});
const stack = async () => {
  const s = await createStack();
  open.push(s);
  return s;
};

describe('startup network consistency (B4)', () => {
  it('refuses to start when WALRUS_NETWORK and TATUM_NETWORK disagree, naming both', async () => {
    await expect(buildRuntime({ WALRUS_NETWORK: 'testnet', TATUM_NETWORK: 'mainnet' })).rejects.toThrow(
      /refusing to start, network mismatch: networks disagree: WALRUS_NETWORK=testnet, TATUM_NETWORK=mainnet/,
    );
  });

  it('refuses to start when DEMO_NETWORK disagrees', async () => {
    await expect(
      buildRuntime({ WALRUS_NETWORK: 'testnet', TATUM_NETWORK: 'testnet', DEMO_NETWORK: 'sui:mainnet' }),
    ).rejects.toThrow(/DEMO_NETWORK=mainnet/);
  });

  it('starts and records the agreed network when the sources agree', async () => {
    const rt = await buildRuntime({ WALRUS_NETWORK: 'testnet', TATUM_NETWORK: 'testnet' });
    try {
      expect(rt.deps.networks).toMatchObject({ sui: 'testnet', walrus: 'testnet', tatum: 'testnet' });
    } finally {
      await rt.close();
    }
  });

  it('catches the case found live: a Mainnet relayer behind testnet labels', async () => {
    const s = await stack();
    const r = await checkRuntimeNetworks({
      env: { WALRUS_NETWORK: 'testnet', TATUM_NETWORK: 'testnet' },
      db: s.deps.db,
      gatewayConfigured: true,
      relayerConfig: async () => ({ network: 'mainnet' }),
    });
    expect(r.mismatches).toEqual([
      'networks disagree: WALRUS_NETWORK=testnet, TATUM_NETWORK=testnet, relayer /config network=mainnet',
    ]);
  });

  it('warns and carries on when the relayer /config cannot be read', async () => {
    const s = await stack();
    const warnings: string[] = [];
    const r = await checkRuntimeNetworks({
      env: { WALRUS_NETWORK: 'testnet', TATUM_NETWORK: 'testnet' },
      db: s.deps.db,
      gatewayConfigured: true,
      relayerConfig: async () => {
        throw new Error('relayer unreachable: fetch failed (UND_ERR_CONNECT_TIMEOUT)');
      },
      warn: (m) => void warnings.push(m),
    });
    expect(r.mismatches).toEqual([]);
    expect(r.network).toBe('testnet');
    expect(warnings[0]).toContain('UND_ERR_CONNECT_TIMEOUT');
  });

  it('treats an unset TATUM_NETWORK as mainnet when a gateway is configured (the gateway default)', async () => {
    const s = await stack();
    const r = await checkRuntimeNetworks({
      env: { WALRUS_NETWORK: 'testnet' },
      db: s.deps.db,
      gatewayConfigured: true,
    });
    expect(r.mismatches[0]).toContain('TATUM_NETWORK=mainnet');
  });

  it('names an existing project that declares another Sui network', async () => {
    const s = await stack();
    const ws = await s.newWorkspace();
    const prj = await s.newProject(ws.id, 'orbit'); // the stack declares sui:mainnet
    const r = await checkRuntimeNetworks({
      env: { WALRUS_NETWORK: 'testnet', TATUM_NETWORK: 'testnet' },
      db: s.deps.db,
      gatewayConfigured: true,
    });
    expect(r.mismatches).toEqual([
      `project ${prj.id} declares sui:mainnet but this deployment is on testnet`,
    ]);
  });
});

describe('project networks must match the deployment', () => {
  it('rejects creating a project on another Sui network, allows other chains', async () => {
    const s = await stack();
    s.deps.networks = { sui: 'testnet' };
    const ws = await s.newWorkspace();
    await expect(s.newProject(ws.id, 'wrong')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      s.newProject(ws.id, 'right', { networks: ['sui:testnet', 'eip155:1'] }),
    ).resolves.toBeTruthy();
  });

  it('shows the networks side by side in the project status', async () => {
    const s = await stack();
    s.deps.networks = { sui: 'testnet', walrus: 'testnet', tatum: 'testnet', relayer: 'testnet' };
    const ws = await s.newWorkspace();
    const prj = await s.newProject(ws.id, 'orbit', { networks: ['sui:testnet'] });
    const st = await s.service.status(systemPrincipal(ws.id), prj.id);
    expect(st.networks).toEqual({
      walrus: 'testnet',
      tatum: 'testnet',
      relayer: 'testnet',
      deployment: 'testnet',
      project: ['sui:testnet'],
      consistent: true,
    });
  });
});

describe('expiry windows follow the network epoch (found on testnet: 5-day memories, 28-day window)', () => {
  const statusExpiring = async (network: 'mainnet' | 'testnet') => {
    const s = await stack();
    s.deps.networks = { sui: network };
    const ws = await s.newWorkspace();
    const prj = await s.newProject(ws.id, 'orbit', { networks: [`sui:${network}`] });
    const a = await s.newAgent({
      workspaceId: ws.id,
      projectId: prj.id,
      name: 'claude-code',
      tool: 'claude-code',
    });
    const day = 86_400_000;
    for (const [i, days] of [1, 3].entries()) {
      const m = await a.backend.remember({ text: `Expiry probe number ${i}.`, type: 'fact' });
      await s.deps.db.system((tx) =>
        tx.query('update memories set expires_at = $2 where id = $1', [
          m.memoryId,
          new Date(s.deps.now() + days * day),
        ]),
      );
    }
    return (await s.service.status(systemPrincipal(ws.id), prj.id)).expiry.expiring;
  };

  it('testnet: only the memory inside two one-day epochs is expiring', async () => {
    expect(await statusExpiring('testnet')).toBe(1);
  });

  it('mainnet: both are inside two fourteen-day epochs', async () => {
    expect(await statusExpiring('mainnet')).toBe(2);
  });
});
