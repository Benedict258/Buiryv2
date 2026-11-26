import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RELEVANCE_CUTOFF, relevance } from '../../packages/core/src/index.js';
import { calibrationQueries, canaryMemoryCandidates } from '../live/calibrate-lib.js';
import { categorySummary, qualityLines, recallQualityRows } from './recall-quality.js';

// Phase 15 B: an offline check of Buiry's lexical relevance against the saved calibration distances. No network, no env.
// The calibration and canary records below are MADE UP in shape only.

const canary = { run: 'abc123', submittedAt: '2026-11-25T20:35:45Z' };
const cal = {
  rows: calibrationQueries(canary).map((q, i) => ({
    category: q.category,
    queryId: q.id,
    results: 1,
    distances: [i / 10],
  })),
};

describe('recallQualityRows', () => {
  it('uses the relevance function and cutoff recall.ts uses, against both canary text candidates', () => {
    const rows = recallQualityRows(cal, canary);
    const qs = calibrationQueries(canary);
    const mem = canaryMemoryCandidates(canary);
    expect(mem).toHaveLength(2);
    expect(rows).toHaveLength(qs.length);
    for (const [i, r] of rows.entries()) {
      const q = qs[i]!;
      expect(r.queryId).toBe(q.id);
      expect(r.category).toBe(q.category);
      expect(r.distance).toBe(i / 10);
      expect(r.relevance).toEqual([relevance(q.text, mem[0]!), relevance(q.text, mem[1]!)]);
      expect(r.kept).toEqual(r.relevance.map((x) => x >= RELEVANCE_CUTOFF));
    }
    expect(RELEVANCE_CUTOFF).toBe(0.2);
  });

  it('keeps a result exactly at the cutoff and drops one just below it', () => {
    const at = recallQualityRows(cal, canary, () => 0.2);
    const below = recallQualityRows(cal, canary, () => 0.19999);
    expect(at.every((r) => r.kept[0] && r.kept[1])).toBe(true);
    expect(below.every((r) => !r.kept[0] && !r.kept[1])).toBe(true);
  });

  it('reads the first raw distance of each saved query, and null when none was returned', () => {
    const rows = recallQualityRows(
      { rows: [{ category: 'exact', queryId: 'q01', results: 0, distances: [] }] },
      canary,
    );
    expect(rows).toEqual([expect.objectContaining({ queryId: 'q01', distance: null })]);
  });
});

describe('categorySummary', () => {
  it('counts kept and dropped per category for each candidate, next to the distance range', () => {
    const rel = (q: string) => (q.includes('chocolate') || q.includes('football') ? 0 : 0.5);
    const s = categorySummary(recallQualityRows(cal, canary, rel));
    const unrelated = s.find((x) => x.category === 'unrelated')!;
    expect(unrelated).toEqual({
      category: 'unrelated',
      queries: 2,
      kept: [0, 0],
      dropped: [2, 2],
      distanceMin: 0.8,
      distanceMax: 0.9,
    });
    expect(s.find((x) => x.category === 'exact')).toMatchObject({
      queries: 2,
      kept: [2, 2],
      dropped: [0, 0],
    });
    expect(s.map((x) => x.category)).toEqual([
      'exact',
      'paraphrase',
      'same-topic',
      'related-topic',
      'unrelated',
    ]);
  });
});

describe('qualityLines (what the script prints)', () => {
  it('prints numbers, ids and categories only: never query text or memory text', () => {
    const rows = recallQualityRows(cal, canary);
    const text = qualityLines(rows, categorySummary(rows)).join('\n');
    for (const q of calibrationQueries(canary)) expect(text).not.toContain(q.text);
    for (const m of canaryMemoryCandidates(canary)) expect(text).not.toContain(m);
    for (const word of ['chocolate', 'football', 'Seal', 'capacity', 'canary abc123'])
      expect(text).not.toContain(word);
    expect(text).toContain('q01 exact distance 0');
    expect(text).toMatch(/cutoff 0\.2/);
  });
});

describe('recall-quality-offline script shape', () => {
  const src = readFileSync(fileURLToPath(new URL('../recall-quality-offline.ts', import.meta.url)), 'utf8');
  it('reads local files only: no network, no env values, no live script', () => {
    expect(src).not.toMatch(
      /fetch\(|HttpWalrusAdapter|buildWalrusAdapter|process\.env|with-env|createGateway/,
    );
    expect(src).toMatch(/readFileSync\(/);
    expect(src).not.toMatch(/writeFileSync\(/);
  });
});
