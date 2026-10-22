import { describe, expect, it } from 'vitest';
import { ago, band, evidenceLabel, short, until, when } from './format';

const NOW = Date.parse('2026-10-22T10:00:00Z');

describe('format', () => {
  it('describes past and future times', () => {
    expect(ago('2026-10-22T09:59:58Z', NOW)).toBe('just now');
    expect(ago('2026-10-22T09:15:00Z', NOW)).toBe('45m ago');
    expect(ago(null, NOW)).toBe('never');
    expect(when('2026-10-22T16:00:00Z', NOW)).toBe('in 6h');
    expect(when('2026-10-22T09:00:00Z', NOW)).toBe('1h ago');
    expect(until('2026-11-21T10:00:00Z', NOW)).toBe('30d');
    expect(until('2026-10-21T10:00:00Z', NOW)).toBe('expired');
  });

  it('bands confidence as the spec does', () => {
    expect(band(0.39)).toBe('low');
    expect(band(0.4)).toBe('medium');
    expect(band(0.7)).toBe('medium');
    expect(band(0.71)).toBe('high');
  });

  it('shortens identifiers and labels evidence', () => {
    expect(short('0x9a3f00000000000000000000000000000000000000000000000000000000c21e')).toBe(
      '0x9a3f0000…c21e',
    );
    expect(evidenceLabel({ kind: 'file', path: 'src/a.ts', commit: '5d9e0aa1234' })).toBe(
      'src/a.ts @ 5d9e0aa',
    );
    expect(evidenceLabel({ kind: 'test', name: 'migrate-batch', result: 'fail' })).toBe(
      'migrate-batch: fail',
    );
    expect(evidenceLabel({ kind: 'url', href: 'https://example.com/docs' })).toBe('example.com/docs');
  });
});
