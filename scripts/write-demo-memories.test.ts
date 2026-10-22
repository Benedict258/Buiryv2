import { describe, expect, it } from 'vitest';
import { DEMO_MEMORIES, writeDemoMemories } from './write-demo-memories.js';

describe('write-demo-memories (mock)', () => {
  it('stores 10+ memories and reports blob ids and expiries', async () => {
    const r = await writeDemoMemories({ mock: true, validUntil: '2026-10-25' });
    expect(DEMO_MEMORIES.length).toBeGreaterThanOrEqual(10);
    expect(r.memories).toHaveLength(DEMO_MEMORIES.length);
    expect(r.memories.every((m) => m.blobId?.startsWith('blob_') && m.expiresAt)).toBe(true);
    expect(r.warnings).toEqual([]);
  }, 120_000);

  it('warns when storage expires before the required date', async () => {
    const r = await writeDemoMemories({ mock: true, validUntil: '2030-01-01' });
    expect(r.warnings.length).toBeGreaterThan(0);
  }, 120_000);
});
