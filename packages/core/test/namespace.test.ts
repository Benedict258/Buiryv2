// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  deriveNamespace,
  idempotencyKey,
  isValidBranchSlug,
  newId,
  parseNamespace,
  isId,
} from '../src/index.js';

const rnd = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) % 256);

describe('namespace', () => {
  const prj = newId('prj', 1_700_000_000_000, rnd);
  it('derives and parses', () => {
    const ns = deriveNamespace(prj, 'feat-auth');
    expect(ns).toBe(`buiry.v1.${prj}.feat-auth`);
    expect(parseNamespace(ns)).toEqual({ projectId: prj, branch: 'feat-auth' });
  });
  it('rejects bad slugs and project ids', () => {
    for (const s of ['', 'Main', 'a_b', '-a', 'a-', 'a--b', 'a.b', 'a b', 'x'.repeat(64)])
      expect(isValidBranchSlug(s), s).toBe(false);
    expect(() => deriveNamespace('prj_x', 'main')).toThrow();
    expect(() => deriveNamespace(prj, '../main')).toThrow();
    expect(() => deriveNamespace('bad id', 'main')).toThrow();
  });
  it('never exceeds 255 bytes for valid input', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z0-9]{1,30}(-[a-z0-9]{1,30}){0,1}$/), (slug) => {
        if (!isValidBranchSlug(slug)) return;
        expect(new TextEncoder().encode(deriveNamespace(prj, slug)).length).toBeLessThanOrEqual(255);
      }),
    );
  });
  it('ids are sortable by time and well formed', () => {
    const a = newId('mem', 1_000, rnd);
    const b = newId('mem', 2_000_000, rnd);
    expect(isId(a, 'mem')).toBe(true);
    expect(a < b).toBe(true);
  });
});

describe('idempotency key', () => {
  it('is deterministic and sensitive to every input', () => {
    const k = idempotencyKey('ns', 'h', 't');
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(idempotencyKey('ns', 'h', 't')).toBe(k);
    expect(idempotencyKey('ns2', 'h', 't')).not.toBe(k);
    expect(idempotencyKey('ns', 'h2', 't')).not.toBe(k);
    expect(idempotencyKey('ns', 'h', 't2')).not.toBe(k);
  });
  it('does not collide across field boundaries', () => {
    expect(idempotencyKey('ab', 'c', 'd')).not.toBe(idempotencyKey('a', 'bc', 'd'));
    expect(idempotencyKey('a', 'bc', 'd')).not.toBe(idempotencyKey('a', 'b', 'cd'));
  });
});
