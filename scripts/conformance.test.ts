import { describe, expect, it } from 'vitest';
import { runConformance } from './conformance.js';

describe('MCP conformance (in-memory + Streamable HTTP, against the in-memory stack)', () => {
  it('passes every scripted check', async () => {
    const checks = await runConformance();
    const failed = checks.filter((c) => !c.ok);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(checks.length).toBeGreaterThan(25);
  }, 120_000);
});
