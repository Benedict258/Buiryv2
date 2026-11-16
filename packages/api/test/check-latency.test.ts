import { describe, expect, it } from 'vitest';
import { Clock, createStack, ids, startGateway } from './helpers.js';

// Phase 2 measurements: a Tatum call took about 0.3 s once connected, with retries and slow connection setup on top.
// buiry_check used to wait for up to three re-verifications in sequence, each capped at 4 s.
describe('buiry_check is never held longer than its re-verification budget', () => {
  it('returns within the budget when the chain is slow, and the check still completes in the background', async () => {
    const c = new Clock();
    const gw = await startGateway(c);
    const delayMs = 3000;
    // A gateway whose package-version reads take 3 s (real time).
    const slow = new Proxy(gw.gateway, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (prop !== 'listPackageVersions') return typeof v === 'function' ? v.bind(target) : v;
        return async (...a: unknown[]) => {
          await new Promise((r) => setTimeout(r, delayMs));
          return (v as (...x: unknown[]) => unknown).apply(target, a);
        };
      },
    });
    const s = await createStack({
      now: c.now,
      gateway: slow,
      reverifyAfterMs: 1000,
      verifyTimeoutMs: 10_000,
      checkReverifyBudgetMs: 300,
    });
    try {
      const ws = await s.newWorkspace();
      const prj = await s.newProject(ws.id);
      const a = await s.newAgent({
        workspaceId: ws.id,
        projectId: prj.id,
        name: 'claude-code',
        tool: 'claude-code',
      });
      const dep = await a.backend.remember({
        text: `Registry package deployed on mainnet at ${ids.PKG_V3}.`,
        type: 'deployment',
        evidence: [{ kind: 'package', id: ids.PKG_V3, network: 'sui:mainnet' }],
      });
      c.advance(5000); // older than reverifyAfterMs, so the check re-verifies it
      const lastVerified = async () =>
        (
          await s.db.system((tx) =>
            tx.query<{ last_verified_at: Date | null }>(
              `select max(last_verified_at) as last_verified_at from evidence where memory_id = $1`,
              [dep.memoryId],
            ),
          )
        ).rows[0]?.last_verified_at ?? null;
      const before = await lastVerified();

      const t0 = performance.now();
      const out = await a.backend.check({ task: 'deploy the registry package' });
      const ms = performance.now() - t0;
      expect(out).toBeTruthy();
      expect(ms).toBeLessThan(delayMs / 2); // the briefing did not wait for the 3 s chain call

      // The re-verification carries on and records its result.
      await new Promise((r) => setTimeout(r, delayMs + 1500));
      const after = await lastVerified();
      expect(after).not.toBeNull();
      expect(after?.toString()).not.toBe(before?.toString());
    } finally {
      await new Promise((r) => setTimeout(r, 200));
      await s.close();
      await gw.close();
    }
  }, 60_000);
});
