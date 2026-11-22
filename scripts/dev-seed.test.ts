import { describe, expect, it } from 'vitest';
import { startDevServer } from './dev-server.js';

// Phase 9 D7: the dashboard's sample data is on Sui testnet, never mainnet, and every seeded view is labelled as
// sample data (the workspace name shows in the sidebar on every page).

describe('dashboard dev seed', () => {
  it('is on testnet and labelled sample data', async () => {
    const dev = await startDevServer({ port: 0, log: () => undefined });
    try {
      const get = async (path: string) =>
        (
          (await (
            await fetch(dev.url + path, { headers: { authorization: `Bearer ${dev.token}` } })
          ).json()) as { data: unknown }
        ).data;
      const project = (await get(`/v1/projects/${dev.projectId}`)) as { networks: string[] };
      expect(project.networks).toEqual(['sui:testnet']);
      const me = (await get('/v1/auth/me')) as { workspaces: { id: string; name: string }[] };
      expect(me.workspaces.find((w) => w.id === dev.workspaceId)?.name).toMatch(/sample data/i);
      const mems = (await get(`/v1/projects/${dev.projectId}/memories?limit=100`)) as unknown;
      expect(JSON.stringify(mems)).not.toMatch(/mainnet/i);
    } finally {
      await dev.close();
    }
  }, 120_000);
});
