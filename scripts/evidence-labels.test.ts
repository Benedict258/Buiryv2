import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Phase 12b: "live" is kept for runs against a live relayer or chain. Real Postgres with test data is its own label.
const doc = readFileSync(
  fileURLToPath(new URL('../docs/design/01-product-and-proof.md', import.meta.url)),
  'utf8',
);
const LABEL = 'verified on real postgres 16 with test data'; // compared lowercased

describe('design/01 evidence labels for real Postgres', () => {
  it('never calls a Postgres result live', () => {
    const offending = doc
      .split('\n')
      .map((line, i) => ({ n: i + 1, line }))
      .filter(({ line }) => /Postgres|L-PG1/.test(line) && /\blive\b/i.test(line))
      .map(({ n }) => n);
    expect(offending).toEqual([]);
  });

  it('labels the isolation suite on real Postgres with the Postgres label', () => {
    const row = doc.split('\n').find((l) => l.startsWith('| Tenant isolation (three layers)'));
    expect(row).toBeDefined();
    expect(row!.toLowerCase()).toContain(LABEL);
    const legend = doc.split('\n').find((l) => l.toLowerCase().startsWith(`| ${LABEL}`));
    expect(legend).toBeDefined();
    expect(legend).toMatch(/isolation suite/);
    expect(legend).toMatch(/L-PG1/);
  });
});
