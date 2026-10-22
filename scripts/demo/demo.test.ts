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

  it('refuses to run live without the live configuration (no pretending)', async () => {
    await expect(runDemo({ live: true, env: {} })).rejects.toThrow(/live mode needs WALRUS_RELAYER_URL/);
  });
});
