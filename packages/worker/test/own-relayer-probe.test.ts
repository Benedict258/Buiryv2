import { describe, expect, it } from 'vitest';
import type { WalrusMemoryAdapter } from '@buiry/storage';
import { StorageRegistry, createStack, setProjectStorage, type UserPrincipal } from '@buiry/api';
import { OWN_RELAYER_NOTICE, ownRelayerProbe } from '../src/index.js';

// Phase 10 F3: in preview (own accounts only, no shared account) each project's own relayer is probed, and a degraded
// relayer shows as a notice in Alerts (an open flag) and in briefings, for that project only. Healthy: no notice.

describe('own relayer probe (preview)', () => {
  it('raises a content-free notice while the own relayer reports writes degraded, and clears it when healthy', async () => {
    let state: { reachable: boolean; writeState: 'ok' | 'degraded' | 'paused' } = {
      reachable: true,
      writeState: 'ok',
    };
    const fake = { health: async () => state } as unknown as WalrusMemoryAdapter;
    const storage = new StorageRegistry({ build: () => fake, tenancy: { multi: false } });
    const s = await createStack({ storage });
    try {
      const ws = await s.newWorkspace('Preview tester');
      const own = await s.newProject(ws.id, 'own', { networks: ['sui:testnet'] });
      const none = await s.newProject(ws.id, 'no-account', { networks: ['sui:testnet'] });
      const admin: UserPrincipal = {
        kind: 'user',
        workspaceId: ws.id,
        userId: 'usr_t',
        displayName: 't',
        role: 'owner',
        projectScope: null,
      };
      await s.db.tenant(ws.id, (tx) =>
        setProjectStorage(
          s.deps,
          tx,
          admin,
          own.id,
          {
            relayerUrl: 'https://relayer.example.test',
            network: 'testnet',
            accountId: '0xabc',
            delegateKey: '55'.repeat(32),
          },
          { resolve: async () => ['93.184.216.34'], probe: async () => ({ network: 'testnet' }) },
        ),
      );
      const agent = await s.newAgent({
        workspaceId: ws.id,
        projectId: own.id,
        name: 'a',
        tool: 'claude-code',
      });
      const openFlags = async (pid: string) =>
        (
          await s.db.system((tx) =>
            tx.query<{ kind: string; detail: string; severity: string }>(
              `select kind, detail, severity from flags where project_id = $1 and kind = 'relayer' and state <> 'resolved'`,
              [pid],
            ),
          )
        ).rows;
      const briefing = async () => JSON.stringify(await agent.backend.check({ task: 'anything' }));

      // Healthy: no notice anywhere.
      await ownRelayerProbe(s.deps, storage);
      expect(await openFlags(own.id)).toEqual([]);
      expect(await briefing()).not.toContain(OWN_RELAYER_NOTICE.degraded);

      // Degraded: a warning flag on that project only, and the notice in its briefing.
      state = { reachable: true, writeState: 'degraded' };
      await ownRelayerProbe(s.deps, storage);
      expect(await openFlags(own.id)).toEqual([
        { kind: 'relayer', detail: OWN_RELAYER_NOTICE.degraded, severity: 'warning' },
      ]);
      expect(await openFlags(none.id)).toEqual([]);
      expect(await briefing()).toContain(OWN_RELAYER_NOTICE.degraded);
      for (const leak of ['relayer.example.test', '0xabc', '5555'])
        expect(OWN_RELAYER_NOTICE.degraded).not.toContain(leak);

      // Recovered: the notice is resolved and leaves the briefing.
      state = { reachable: true, writeState: 'ok' };
      await ownRelayerProbe(s.deps, storage);
      expect(await openFlags(own.id)).toEqual([]);
      expect(await briefing()).not.toContain(OWN_RELAYER_NOTICE.degraded);
    } finally {
      await s.close();
    }
  });
});

describe('shared-account probe leaves own-account projects to their own probe', () => {
  it('a degraded shared relayer flags shared projects only, not a project with its own account', async () => {
    const { relayerProbe } = await import('../src/index.js');
    const degraded = {
      health: async () => ({ reachable: true, writeState: 'degraded' as const }),
    } as unknown as WalrusMemoryAdapter;
    const storage = new StorageRegistry({
      managed: degraded,
      build: () => degraded,
      tenancy: { multi: true },
    });
    const s = await createStack({ storage });
    try {
      const ws = await s.newWorkspace('Mixed');
      const shared = await s.newProject(ws.id, 'shared', { networks: ['sui:testnet'] });
      const own = await s.newProject(ws.id, 'own', { networks: ['sui:testnet'] });
      const admin: UserPrincipal = {
        kind: 'user',
        workspaceId: ws.id,
        userId: 'usr_m',
        displayName: 'm',
        role: 'owner',
        projectScope: null,
      };
      await s.db.tenant(ws.id, (tx) =>
        setProjectStorage(
          s.deps,
          tx,
          admin,
          own.id,
          {
            relayerUrl: 'https://relayer.example.test',
            network: 'testnet',
            accountId: '0xabc',
            delegateKey: '55'.repeat(32),
          },
          { resolve: async () => ['93.184.216.34'], probe: async () => ({ network: 'testnet' }) },
        ),
      );
      await relayerProbe(s.deps, degraded, '');
      const flagged = async (pid: string) =>
        (
          await s.db.system((tx) =>
            tx.query(
              `select 1 from flags where project_id = $1 and kind = 'relayer' and state <> 'resolved'`,
              [pid],
            ),
          )
        ).rows.length;
      expect(await flagged(shared.id)).toBe(1);
      expect(await flagged(own.id)).toBe(0);
    } finally {
      await s.close();
    }
  });
});
