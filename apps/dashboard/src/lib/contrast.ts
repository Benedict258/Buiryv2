/** WCAG 2.x contrast for the dashboard tokens (Phase 9 D1). Pure: takes the text of tokens.css. */

export type Theme = 'dark' | 'light';

/** Token values per theme, read from the `:root[data-theme=...]` blocks (dark also covers bare `:root`). */
export function readTokens(css: string): Record<Theme, Record<string, string>> {
  const block = (sel: RegExp) => {
    const m = css.match(sel);
    if (!m) throw new Error(`theme block not found: ${sel}`);
    const out: Record<string, string> = {};
    for (const d of m[1]!.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g))
      out[d[1]!] = d[2]!.toLowerCase();
    return out;
  };
  return {
    dark: block(/:root\[data-theme='dark'\]\s*\{([^}]*)\}/),
    light: block(/:root\[data-theme='light'\]\s*\{([^}]*)\}/),
  };
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lin = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const lum = (hex: string) => {
  const [r, g, b] = rgb(hex).map(lin) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** Contrast ratio of two colours, 1 to 21. */
export function ratio(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** `color-mix(in srgb, fg pct%, bg)`, as the status chips paint their background. */
export function mix(fg: string, bg: string, pct: number): string {
  const f = rgb(fg);
  const b = rgb(bg);
  return (
    '#' +
    f
      .map((c, i) => Math.round(c * pct + b[i]! * (1 - pct)))
      .map((c) => c.toString(16).padStart(2, '0'))
      .join('')
  );
}

export interface ContrastRow {
  theme: Theme;
  pair: string;
  fg: string;
  bg: string;
  ratio: number;
  /** The minimum the pair must reach; null when listed for information only. */
  min: number | null;
}

/** Chip background tint per theme; must equal `--chip-tint` in tokens.css (checked by the test). */
export const CHIP_TINT: Record<Theme, number> = { dark: 0, light: 0.12 };

/**
 * Pairs below their minimum that are kept on purpose because they are the palette brief's own values, pending the
 * owner's decision (Phase 9 report). Any other failure fails the test.
 */
export const KNOWN_EXCEPTIONS: string[] = [];

const STATUS = [
  'proposed',
  'confirmed',
  'contested',
  'stale',
  'superseded',
  'tombstoned',
  'expired',
] as const;

/** Every pair the dashboard relies on, with its required minimum (4.5 text, 3 for focus rings and input borders). */
export function contrastReport(css: string): ContrastRow[] {
  const t = readTokens(css);
  const rows: ContrastRow[] = [];
  for (const theme of ['dark', 'light'] as const) {
    const v = t[theme];
    const get = (k: string) => {
      const x = v[k];
      if (!x) throw new Error(`${theme}: ${k} is not a hex token`);
      return x;
    };
    const add = (pair: string, fg: string, bg: string, min: number | null) =>
      rows.push({ theme, pair, fg, bg, ratio: Math.round(ratio(fg, bg) * 100) / 100, min });
    for (const bg of ['--bg-canvas', '--bg-surface', '--bg-raised']) {
      add(`text on ${bg}`, get('--text-primary'), get(bg), 4.5);
      add(`text-muted on ${bg}`, get('--text-secondary'), get(bg), 4.5);
    }
    add('link on bg', get('--link'), get('--bg-canvas'), 4.5);
    add('link on surface', get('--link'), get('--bg-surface'), 4.5);
    add('on-primary on primary', get('--on-brand'), get('--brand'), 4.5);
    add('on-primary on primary hover', get('--on-brand'), get('--brand-hover'), 4.5);
    add('primary on selected (active nav)', get('--brand'), get('--brand-subtle'), 4.5);
    add('accent-ink on accent (verified chip)', get('--accent-ink'), get('--accent'), 4.5);
    add('on-danger on solid danger button', get('--on-danger'), get('--danger-solid'), 4.5);
    for (const s of STATUS) {
      const c = get(`--s-${s}`);
      add(`${s} text on surface`, c, get('--bg-surface'), 4.5);
      add(`${s} text on bg`, c, get('--bg-canvas'), 4.5);
      add(`${s} text on its chip`, c, mix(c, get('--bg-surface'), CHIP_TINT[theme]), 4.5);
    }
    add('danger outline button text on surface', get('--s-stale'), get('--bg-surface'), 4.5);
    add('focus ring on bg', get('--focus'), get('--bg-canvas'), 3);
    add('focus ring on surface', get('--focus'), get('--bg-surface'), 3);
    add('input border on surface', get('--input-border'), get('--bg-surface'), 3);
    add('input border on bg', get('--input-border'), get('--bg-canvas'), 3);
    for (const f of ['--f-success', '--f-warning', '--f-danger', '--f-info'])
      add(`${f} fill on surface (with icon and label)`, get(f), get('--bg-surface'), null);
  }
  return rows;
}
