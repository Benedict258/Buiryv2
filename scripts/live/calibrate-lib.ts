/**
 * Phase 14 B: read-only recall calibration (pure part). A fixed set of at most 12 labelled queries against the canary's
 * namespace, one recall each, spaced at least 2 s apart, stopping on the first error. What is kept per query: the
 * category label, the query id, the number of results and their raw distances. Never query text, never memory text.
 * The adapter type allows `recall` only, so nothing here can write.
 */
import type { RecallRequest, RecallResponse } from '../../packages/storage/src/index.js';
import { errorText } from '../lib/errors.js';

export const CALIBRATION_CATEGORIES = [
  'exact',
  'paraphrase',
  'same-topic',
  'related-topic',
  'unrelated',
] as const;
export type CalibrationCategory = (typeof CALIBRATION_CATEGORIES)[number];
export const MAX_CALIBRATION_QUERIES = 12;
export const MIN_RECALL_SPACING_MS = 2000;

export interface CalibrationQuery {
  id: string;
  category: CalibrationCategory;
  /** Sent to the relayer only; never saved or printed. */
  text: string;
}

export interface CalibrationRow {
  category: CalibrationCategory;
  queryId: string;
  results: number;
  distances: (number | null)[];
}

/** The canary's memory text, as `scripts/live/canary.ts` builds it (run id and a second-resolution UTC time). */
const canaryText = (run: string, at: string) => `Buiry canary ${run}: a one-line test memory written ${at}.`;
const secondBefore = (iso: string) => new Date(Date.parse(iso) - 1000).toISOString().slice(0, 19) + 'Z';

/**
 * The canary memory's text candidates for one saved canary run (Phase 15): at the submit second and the second before,
 * since the canary saves only its submit time. One of the two is the stored text. Used offline only; never printed.
 */
export function canaryMemoryCandidates(c: { run: string; submittedAt: string }): [string, string] {
  return [canaryText(c.run, c.submittedAt), canaryText(c.run, secondBefore(c.submittedAt))];
}

/**
 * The fixed query set for one canary. The canary takes its text's time just before it submits and saves only the
 * submit time, so `exact` tries the submit second and the second before; one of the two is the exact text.
 */
export function calibrationQueries(c: { run: string; submittedAt: string }): CalibrationQuery[] {
  const at = c.submittedAt;
  return [
    { id: 'q01', category: 'exact', text: canaryText(c.run, at) },
    { id: 'q02', category: 'exact', text: canaryText(c.run, secondBefore(at)) },
    {
      id: 'q03',
      category: 'paraphrase',
      text: `Buiry canary ${c.run}: a single-line test memory, written ${at}.`,
    },
    {
      id: 'q04',
      category: 'paraphrase',
      text: `A one-line test memory written by the Buiry canary ${c.run}.`,
    },
    {
      id: 'q05',
      category: 'same-topic',
      text: 'A short trial note saved to check that storage writes work.',
    },
    {
      id: 'q06',
      category: 'same-topic',
      text: 'Test entry recorded to confirm the memory store accepts writes.',
    },
    {
      id: 'q07',
      category: 'related-topic',
      text: 'The storage relayer reported a temporary capacity limit on uploads.',
    },
    {
      id: 'q08',
      category: 'related-topic',
      text: 'How encrypted memories are recalled with a Seal session.',
    },
    { id: 'q09', category: 'unrelated', text: 'A recipe for chocolate cake with fresh strawberries.' },
    { id: 'q10', category: 'unrelated', text: "Results of last weekend's football league matches." },
  ];
}

export interface CalibrationOutput {
  rows: CalibrationRow[];
  /** The query whose recall failed, and the error's name and kind only; calibration stopped there. */
  stoppedOnError?: { queryId: string; error: string };
}

/** Runs the queries in order: one recall each, no retry, at least 2 s apart, stop on the first error. */
export async function runCalibration(
  adapter: { recall(req: RecallRequest): Promise<RecallResponse> },
  o: {
    namespace: string;
    queries: CalibrationQuery[];
    sleep?: (ms: number) => Promise<void>;
    limit?: number;
  },
): Promise<CalibrationOutput> {
  if (o.queries.length > MAX_CALIBRATION_QUERIES)
    throw new Error(`calibration runs at most ${MAX_CALIBRATION_QUERIES} queries; got ${o.queries.length}`);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rows: CalibrationRow[] = [];
  for (const [i, q] of o.queries.entries()) {
    if (i > 0) await sleep(MIN_RECALL_SPACING_MS);
    try {
      const r = await adapter.recall({ namespace: o.namespace, query: q.text, limit: o.limit ?? 5 });
      rows.push({
        category: q.category,
        queryId: q.id,
        results: r.results.length,
        distances: r.results.map((x) => (typeof x.distance === 'number' ? x.distance : null)),
      });
    } catch (e) {
      return {
        rows,
        stoppedOnError: { queryId: q.id, error: errorText(e) },
      };
    }
  }
  return { rows };
}
