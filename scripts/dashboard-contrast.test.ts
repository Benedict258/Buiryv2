import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CHIP_TINT,
  KNOWN_EXCEPTIONS,
  contrastReport,
  ratio,
  readTokens,
} from '../apps/dashboard/src/lib/contrast';

const tokens = readFileSync(new URL('../apps/dashboard/src/styles/tokens.css', import.meta.url), 'utf8');

// Phase 9 D1: the palette brief's values are in tokens.css, and every text pair reaches 4.5:1, focus rings and input
// borders 3:1. Status fills are listed for information: they are never the only signal (icon and label too).

describe('dashboard tokens', () => {
  it('match the palette brief', () => {
    const t = readTokens(tokens);
    expect(t.light).toMatchObject({
      '--bg-canvas': '#f4f5f1',
      '--bg-surface': '#fdfefc',
      '--border-default': '#dde2dc',
      '--bg-raised': '#e8ebe5',
      '--text-primary': '#0a1f1b',
      '--text-secondary': '#5b6b65',
      '--brand': '#0a1f1b',
      '--on-brand': '#eef3ef',
      '--brand-hover': '#1b4a3b',
      '--focus': '#1b4a3b',
      '--accent': '#bfea7a',
      '--accent-ink': '#1b2a08',
      '--input-border': '#90948f',
      '--s-confirmed': '#007a38',
      '--s-contested': '#955b00',
      '--s-stale': '#c82a36',
      '--s-proposed': '#3663d2',
    });
    expect(t.dark).toMatchObject({
      '--bg-canvas': '#0a1f1b',
      '--bg-surface': '#122b25',
      '--border-default': '#2a3d39',
      '--text-primary': '#eef3ef',
      '--text-secondary': '#a6b5ad',
      '--brand': '#bfea7a',
      '--on-brand': '#1b2a08',
      '--brand-subtle': '#1b4a3b',
      '--focus': '#bfea7a',
      '--input-border': '#64736d',
      '--s-confirmed': '#15a25e',
      '--s-stale': '#f5585b',
      '--s-contested': '#e3a52c',
      '--s-proposed': '#5b8cff',
    });
    for (const th of ['dark', 'light'] as const)
      expect(t[th]).toMatchObject({
        '--f-success': '#0d9f5b',
        '--f-warning': '#e3a52c',
        '--f-danger': '#e5484d',
        '--f-info': '#5b8cff',
        '--danger-solid': '#ce303a',
        '--on-danger': '#eef3ef',
      });
  });

  it('computes WCAG ratios correctly', () => {
    expect(ratio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(ratio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });

  it('every required pair meets its minimum', () => {
    const failing = contrastReport(tokens)
      .filter((r) => r.min !== null && r.ratio < r.min)
      .map((r) => `${r.theme}|${r.pair}`);
    expect(failing).toEqual(KNOWN_EXCEPTIONS);
  });

  it('the chip tint the report assumes is the one in tokens.css', () => {
    const tint = [...tokens.matchAll(/--chip-tint:\s*(\d+)%/g)].map((m) => Number(m[1]) / 100);
    expect(tint).toEqual([CHIP_TINT.dark, CHIP_TINT.light]);
  });
});
