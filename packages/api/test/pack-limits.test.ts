import { describe, expect, it } from 'vitest';
import { BuiryError } from '@buiry/core';
import { createStack } from './helpers.js';
import {
  importPack,
  packChecksum,
  packLimits,
  previewPack,
  type Pack,
  type UserPrincipal,
} from '../src/index.js';

// SECURITY_REVIEW M7: pack preview and import cap the number of items, the text length and the evidence per item,
// and refuse an oversized pack before doing any per-item work.

type Item = Pack['memories'][number];
const item = (i: number, over: Partial<Item> = {}): Item => ({
  id: `src_${i}`,
  type: 'fact',
  status: 'proposed',
  text: `Pack fact ${i}.`,
  confidence: 0.5,
  branch: 'main',
  agent: 'exporter',
  evidence: [],
  createdAt: '2026-11-01T00:00:00.000Z',
  event: '',
  ...over,
});
const packOf = (memories: Item[]): Pack => ({
  manifest: {
    protocol: 1,
    project: { name: 'src', networks: [] },
    exportedAt: '2026-11-01T00:00:00.000Z',
    counts: { total: memories.length, byType: {} },
    checksum: packChecksum(memories),
  },
  memories,
});

describe('pack limits', () => {
  it('refuses too many items, over-long text and too much evidence; accepts a pack within limits', async () => {
    const s = await createStack({ packMaxItems: 3, maxTextLength: 50 });
    const ws = await s.newWorkspace();
    const prj = await s.newProject(ws.id);
    const p: UserPrincipal = {
      kind: 'user',
      workspaceId: ws.id,
      userId: 'usr_o',
      displayName: 'o',
      role: 'owner',
      projectScope: null,
    };
    const preview = (pack: Pack) =>
      s.db.tenant(ws.id, (tx) => previewPack(tx, p, prj.id, pack, packLimits(s.deps)));

    const tooMany = packOf([item(1), item(2), item(3), item(4)]);
    const r1 = await preview(tooMany);
    expect(r1.valid).toBe(false);
    expect(r1.errors.join()).toContain('at most 3');
    expect(r1.items).toHaveLength(0);
    const e1 = await importPack(s.deps, p, prj.id, tooMany, {}).catch((e: BuiryError) => e);
    expect((e1 as BuiryError).code).toBe('invalid_input');

    const r2 = await preview(packOf([item(1, { text: 'x'.repeat(51) })]));
    expect(r2.errors.join()).toContain('longer than 50 characters');

    const evidence = Array.from({ length: 21 }, (_, k) => ({
      kind: 'url' as const,
      url: `https://e.example/${k}`,
    }));
    const r3 = await preview(packOf([item(1, { evidence: evidence as never })]));
    expect(r3.errors.join()).toContain('more than 20 evidence entries');

    const ok = packOf([item(1), item(2), item(3)]);
    expect((await preview(ok)).valid).toBe(true);
    const out = await importPack(s.deps, p, prj.id, ok, {});
    expect(JSON.stringify(out)).toContain('src_3');
    await s.close();
  });
});
