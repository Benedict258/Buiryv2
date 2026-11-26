/**
 * Phase 15 B: offline recall-quality check. Reads a saved calibration result and its canary record (local files only:
 * no network, no env) and prints, per query, the category, query id, the relayer's raw distance, Buiry's lexical
 * relevance and whether the current 0.2 cutoff keeps it, plus a per-category summary. Never prints query text or memory
 * text. Changes nothing.
 *
 *   pnpm tsx scripts/recall-quality-offline.ts [.buiry-local/proof/calibrate-<run>-<id>.json]
 */
import { readFileSync } from 'node:fs';
import { categorySummary, qualityLines, recallQualityRows } from './lib/recall-quality.js';

const calFile = process.argv[2] ?? '.buiry-local/proof/calibrate-118193-d6243d.json';
const cal = JSON.parse(readFileSync(calFile, 'utf8')) as {
  canaryRun: string;
  rows: { category: string; queryId: string; distances: (number | null)[] }[];
};
if (!/^[0-9a-f]{6}$/.test(cal.canaryRun)) {
  console.error('[recall-quality] the calibration file names no valid canary run');
  process.exit(64);
}
const canary = JSON.parse(readFileSync(`.buiry-local/proof/canary-${cal.canaryRun}.json`, 'utf8')) as {
  run: string;
  submittedAt?: string;
};
if (!canary.submittedAt) {
  console.error(`[recall-quality] canary ${cal.canaryRun} has no submit time`);
  process.exit(64);
}
const rows = recallQualityRows(cal, { run: canary.run, submittedAt: canary.submittedAt });
for (const line of qualityLines(rows, categorySummary(rows))) console.log(`[recall-quality] ${line}`);
