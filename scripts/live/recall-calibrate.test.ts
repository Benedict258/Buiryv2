import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CALIBRATION_CATEGORIES,
  MAX_CALIBRATION_QUERIES,
  MIN_RECALL_SPACING_MS,
  calibrationQueries,
  runCalibration,
  type CalibrationQuery,
} from './calibrate-lib.js';
import { canaryPreflight } from './canary-lib.js';
import type { RecallRequest, RecallResponse } from '../../packages/storage/src/index.js';

// Phase 14 B: a read-only calibration of recall distances. Recalls only, at most 12, one per query, spaced at least
// 2 s apart, stop on the first error; saves category, query id, result count and raw distances, never any text.

const canary = { run: 'abc123', submittedAt: '2026-11-25T20:35:45Z' };
const canaryText = (t: string) => `Buiry canary abc123: a one-line test memory written ${t}.`;

const fakeAdapter = (recall: (q: string) => RecallResponse) => ({
  recall: vi.fn(async (req: RecallRequest): Promise<RecallResponse> => recall(req.query)),
  remember: vi.fn(),
  rememberBulk: vi.fn(),
  forget: vi.fn(),
  restore: vi.fn(),
});
const hit = (distance: number) => ({
  results: [
    { blobId: 'b', text: 'memory text that must never be saved', distance, fields: ['blob_id', 'distance'] },
  ],
});

describe('calibration query set', () => {
  const qs = calibrationQueries(canary);
  it('has at most 12 queries, unique ids, and every labelled category', () => {
    expect(qs.length).toBeLessThanOrEqual(MAX_CALIBRATION_QUERIES);
    expect(MAX_CALIBRATION_QUERIES).toBe(12);
    expect(new Set(qs.map((q) => q.id)).size).toBe(qs.length);
    expect([...new Set(qs.map((q) => q.category))].sort()).toEqual([...CALIBRATION_CATEGORIES].sort());
    expect(CALIBRATION_CATEGORIES).toEqual([
      'exact',
      'paraphrase',
      'same-topic',
      'related-topic',
      'unrelated',
    ]);
  });
  it("the exact category tries the canary's own text at the submit second and the second before", () => {
    const exact = qs.filter((q) => q.category === 'exact').map((q) => q.text);
    expect(exact).toEqual([canaryText('2026-11-25T20:35:45Z'), canaryText('2026-11-25T20:35:44Z')]);
  });
});

describe('runCalibration', () => {
  const qs = calibrationQueries(canary);
  const noSleep = vi.fn(async () => {});

  it('recalls once per query and never calls a write, forget or restore method', async () => {
    const a = fakeAdapter(() => hit(0.1));
    await runCalibration(a, { namespace: 'buiry.canary.abc123', queries: qs, sleep: noSleep });
    expect(a.recall).toHaveBeenCalledTimes(qs.length);
    for (const m of [a.remember, a.rememberBulk, a.forget, a.restore]) expect(m).not.toHaveBeenCalled();
    expect(a.recall.mock.calls.every(([req]) => req.namespace === 'buiry.canary.abc123')).toBe(true);
  });

  it('refuses more than 12 queries before any recall', async () => {
    const a = fakeAdapter(() => hit(0.1));
    const many: CalibrationQuery[] = Array.from({ length: 13 }, (_, i) => ({
      id: `q${i + 1}`,
      category: 'unrelated',
      text: `made-up query ${i}`,
    }));
    await expect(runCalibration(a, { namespace: 'ns', queries: many, sleep: noSleep })).rejects.toThrow(
      /at most 12 queries/,
    );
    expect(a.recall).not.toHaveBeenCalled();
  });

  it('waits at least 2 s between recalls, never before the first', async () => {
    const order: string[] = [];
    const sleep = vi.fn(async (ms: number) => void order.push(`sleep ${ms}`));
    const a = fakeAdapter((q) => (order.push('recall'), q ? hit(0.2) : hit(0.2)));
    await runCalibration(a, { namespace: 'ns', queries: qs.slice(0, 3), sleep });
    expect(MIN_RECALL_SPACING_MS).toBeGreaterThanOrEqual(2000);
    expect(order).toEqual([
      'recall',
      `sleep ${MIN_RECALL_SPACING_MS}`,
      'recall',
      `sleep ${MIN_RECALL_SPACING_MS}`,
      'recall',
    ]);
  });

  it('stops on the first error, with no retry, and records which query failed', async () => {
    let n = 0;
    const a = fakeAdapter(() => {
      n++;
      if (n === 3)
        throw Object.assign(new Error('relayer timed out'), { name: 'RelayerError', kind: 'timeout' });
      return hit(0.3);
    });
    const out = await runCalibration(a, { namespace: 'ns', queries: qs, sleep: noSleep });
    expect(a.recall).toHaveBeenCalledTimes(3);
    expect(out.rows).toHaveLength(2);
    expect(out.stoppedOnError).toEqual({
      queryId: qs[2]!.id,
      error: 'RelayerError class=timeout kind=timeout',
    });
  });

  it('saves only category, query id, result count and raw distances: never query or memory text', async () => {
    const a = fakeAdapter((q) =>
      q.includes('cake') ? { results: [] } : { results: [...hit(0.00000066).results, ...hit(0.5).results] },
    );
    const out = await runCalibration(a, { namespace: 'ns', queries: qs, sleep: noSleep });
    for (const r of out.rows)
      expect(Object.keys(r).sort()).toEqual(['category', 'distances', 'queryId', 'results']);
    expect(out.rows[0]).toEqual({
      category: 'exact',
      queryId: qs[0]!.id,
      results: 2,
      distances: [0.00000066, 0.5],
    });
    expect(out.rows.find((r) => r.results === 0)?.distances).toEqual([]);
    const json = JSON.stringify(out);
    expect(json).not.toContain('memory text');
    for (const q of qs) expect(json).not.toContain(q.text);
    expect(json).not.toContain('abc123');
  });
});

describe('recall-calibrate script (guards and shape)', () => {
  const src = readFileSync(fileURLToPath(new URL('./recall-calibrate.ts', import.meta.url)), 'utf8');
  const body = src
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\*\*|\/\/)/.test(l))
    .join('\n');

  it('runs the canary preflight (account A, network, mainnet opt-in, gateway) before anything connects', () => {
    const pre = body.indexOf('canaryPreflight(');
    expect(pre).toBeGreaterThan(0);
    for (const later of [
      'buildWalrusAdapter(',
      'createGatewayIfConfigured(',
      'relayerConfig(',
      'runCalibration(',
    ])
      expect(body.indexOf(later), later).toBeGreaterThan(pre);
    expect(body).toMatch(
      /relayerNetworkProblem\(\(await adapter\.relayerConfig\(\)\)\.network, pre\.network\)/,
    );
    const mainnetNoOptIn = canaryPreflight(
      {
        BYO_A_RELAYER_URL: 'https://relayer.memory.walrus.xyz',
        BYO_A_ACCOUNT_ID: '0x1',
        BYO_A_DELEGATE_KEY: 'made-up',
        WALRUS_NETWORK: 'mainnet',
        TATUM_NETWORK: 'mainnet',
      },
      { gatewayConfigured: true },
    );
    expect(mainnetNoOptIn.ok).toBe(false);
  });

  it('never writes, never retries a read, and reads the canary namespace', () => {
    expect(body).not.toMatch(/\.(remember|rememberBulk|forget|restore)\(/);
    expect(body).toMatch(/\{ readRetries: 0 \}/);
    expect(body).toContain('`buiry.canary.${canaryRun}`');
    expect(body).not.toContain('writeFileSync(LAST');
  });
});
