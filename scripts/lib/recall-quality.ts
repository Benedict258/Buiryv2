/**
 * Phase 15 B: offline recall-quality check (pure part). For each saved calibration query it computes Buiry's own lexical
 * relevance against the canary memory, with the same `relevance` and `RELEVANCE_CUTOFF` that
 * `packages/storage/src/recall.ts` uses (imported from @buiry/core, not copied), next to the relayer's raw distance.
 * Nothing here changes the cutoff, the ranking or any recall code. Output carries numbers, ids and category labels
 * only: never query text or memory text.
 */
import { RELEVANCE_CUTOFF, relevance } from '../../packages/core/src/index.js';
import {
  CALIBRATION_CATEGORIES,
  calibrationQueries,
  canaryMemoryCandidates,
  type CalibrationCategory,
} from '../live/calibrate-lib.js';

export interface QualityRow {
  category: CalibrationCategory;
  queryId: string;
  /** The relayer's raw distance for the canary memory (the namespace holds one memory); null when none returned. */
  distance: number | null;
  /** Lexical relevance against the two canary text candidates (submit second, second before). */
  relevance: [number, number];
  /** Whether the current cutoff keeps the result, per candidate (`relevance >= RELEVANCE_CUTOFF`, as in recall.ts). */
  kept: [boolean, boolean];
}

export function recallQualityRows(
  cal: { rows: { category: string; queryId: string; results?: number; distances: (number | null)[] }[] },
  canary: { run: string; submittedAt: string },
  rel: (query: string, text: string) => number = relevance,
  cutoff: number = RELEVANCE_CUTOFF,
): QualityRow[] {
  const queries = new Map(calibrationQueries(canary).map((q) => [q.id, q]));
  const [m0, m1] = canaryMemoryCandidates(canary);
  return cal.rows.flatMap((r) => {
    const q = queries.get(r.queryId);
    if (!q || q.category !== r.category) return [];
    const relevanceBoth: [number, number] = [rel(q.text, m0), rel(q.text, m1)];
    const d = r.distances[0];
    return [
      {
        category: q.category,
        queryId: q.id,
        distance: typeof d === 'number' ? d : null,
        relevance: relevanceBoth,
        kept: [relevanceBoth[0] >= cutoff, relevanceBoth[1] >= cutoff],
      },
    ];
  });
}

export interface CategorySummary {
  category: CalibrationCategory;
  queries: number;
  kept: [number, number];
  dropped: [number, number];
  distanceMin: number | null;
  distanceMax: number | null;
}

export function categorySummary(rows: QualityRow[]): CategorySummary[] {
  return CALIBRATION_CATEGORIES.flatMap((category) => {
    const rs = rows.filter((r) => r.category === category);
    if (!rs.length) return [];
    const ds = rs.map((r) => r.distance).filter((d): d is number => d !== null);
    const kept: [number, number] = [rs.filter((r) => r.kept[0]).length, rs.filter((r) => r.kept[1]).length];
    return [
      {
        category,
        queries: rs.length,
        kept,
        dropped: [rs.length - kept[0], rs.length - kept[1]],
        distanceMin: ds.length ? Math.min(...ds) : null,
        distanceMax: ds.length ? Math.max(...ds) : null,
      },
    ];
  });
}

const num = (x: number | null) => (x === null ? 'none' : String(x));
const rel4 = (x: number) => x.toFixed(4);

/** The lines the script prints: numbers, ids and category labels only. */
export function qualityLines(
  rows: QualityRow[],
  summary: CategorySummary[],
  cutoff: number = RELEVANCE_CUTOFF,
): string[] {
  return [
    `cutoff ${cutoff} (relevance >= cutoff is kept); relevance shown for both canary text candidates [submit second, second before]`,
    ...rows.map(
      (r) =>
        `${r.queryId} ${r.category} distance ${num(r.distance)} relevance [${rel4(r.relevance[0])}, ${rel4(r.relevance[1])}] kept [${r.kept[0] ? 'yes' : 'no'}, ${r.kept[1] ? 'yes' : 'no'}]`,
    ),
    ...summary.map(
      (s) =>
        `summary ${s.category}: ${s.queries} queries; kept [${s.kept[0]}, ${s.kept[1]}], dropped [${s.dropped[0]}, ${s.dropped[1]}]; distance ${num(s.distanceMin)} to ${num(s.distanceMax)}`,
    ),
  ];
}
