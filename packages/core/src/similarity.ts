// SPDX-License-Identifier: Apache-2.0

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function trigrams(text: string): Set<string> {
  const n = ` ${normalize(text)} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= n.length; i++) out.add(n.slice(i, i + 3));
  return out;
}

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const STOP = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'for',
  'is',
  'are',
  'it',
  'we',
  'with',
  'be',
  'by',
]);

export function tokens(text: string): Set<string> {
  return new Set(
    normalize(text)
      .split(' ')
      .filter((t) => t.length > 1 && !STOP.has(t)),
  );
}

/** Deterministic text similarity in [0, 1]: the larger of trigram and token Jaccard. */
export function similarity(a: string, b: string): number {
  return Math.max(jaccard(trigrams(a), trigrams(b)), jaccard(tokens(a), tokens(b)));
}

/** Relevance of a candidate to a task: token overlap relative to the task, blended with similarity. */
export function relevance(task: string, text: string): number {
  const t = tokens(task);
  if (t.size === 0) return 0;
  const x = tokens(text);
  let hit = 0;
  for (const w of t) if (x.has(w)) hit++;
  return Math.min(1, Math.max(hit / t.size, similarity(task, text)));
}
