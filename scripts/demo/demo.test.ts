import { describe, expect, it } from 'vitest';
import { runDemo } from './run.js';

describe('two-agent demo on mocks', () => {
  it('shows the failure to the second agent first, catches drift, and corrects it from a digest', async () => {
    const lines: string[] = [];
    const r = await runDemo({ log: (s) => lines.push(s) });
    expect(r).toMatchObject({
      mode: 'mock',
      firstConnectionOfB: true,
      failureShownFirst: true,
      staleDetected: true,
      staleFlagShownAtCheck: true,
    });
    expect(r.correctedConfidence).toBe(0.6);
    expect(r.blobIds.length).toBeGreaterThanOrEqual(4);
    expect(r.blobIds.every((b) => b.startsWith('blob_'))).toBe(true);
    expect(r.expiries.every(Boolean)).toBe(true);
    expect(r.tatumCalls).toBeGreaterThan(0);
    const out = lines.join('\n');
    expect(out).toContain('Failures to avoid');
    expect(out).toContain('package upgraded: cited version 3, latest 4');
    expect(out).toContain('memory status is now: stale');
  }, 180_000);

  it('waits for expiry when the relayer reports it minutes after the write (found live on testnet)', async () => {
    const lines: string[] = [];
    const r = await runDemo({ log: (s) => lines.push(s), mockExpiryLagMs: 5 * 60_000 });
    expect(r.expiries.every(Boolean)).toBe(true);
    expect(lines.join('\n')).toMatch(/expiry read from the relayer listing after [1-9]\d* s/);
    expect(lines.join('\n')).toMatch(/\(end epoch \d+\)/);
  }, 180_000);

  it('fresh package: the deployment is verified when written and goes stale only after the upgrade', async () => {
    const lines: string[] = [];
    const r = await runDemo({ log: (s) => lines.push(s), freshPackage: true });
    // Before the upgrade: the write-time check passes, so the memory is not stale.
    expect(r.deploymentStatusAfterWrite).toBe('proposed');
    // After the upgrade: B's first check re-verifies chain evidence and already sees the drift (as live did).
    expect(r.deploymentStatusAtFirstBriefing).toBe('stale');
    // After the upgrade: drift is caught, flagged at the next check, and corrected from the upgrade digest.
    expect(r.staleDetected).toBe(true);
    expect(r.staleFlagShownAtCheck).toBe(true);
    expect(r.freshPackage).toMatchObject({ v1: '0x' + 'f1'.repeat(32), v2: '0x' + 'f2'.repeat(32) });
    const out = lines.join('\n');
    expect(out).toContain('package upgraded: cited version 1, latest 2');
    expect(out.indexOf('Between sessions: the package is upgraded')).toBeGreaterThan(
      out.indexOf('after session 1'),
    );
    expect(r.correctedConfidence).toBe(0.6);
    expect(out).toMatch(/with 3 evidence items/); // tx, new package, mutated UpgradeCap
  }, 180_000);

  it('refuses to run live without the live configuration (no pretending)', async () => {
    await expect(runDemo({ live: true, env: {} })).rejects.toThrow(/live mode needs WALRUS_RELAYER_URL/);
  });
});
