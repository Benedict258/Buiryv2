// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  decodeMemory,
  encodeMemory,
  decodeHeader,
  type Evidence,
  type MemoryHeader,
  MEMORY_TYPES,
  TIER_A_EVENTS,
} from '../src/index.js';

const slug = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,20}$/);
const val = fc.stringMatching(/^[A-Za-z0-9._:-]{1,30}$/);
const headerArb: fc.Arbitrary<MemoryHeader> = fc.record(
  {
    evt: fc.constantFrom(...TIER_A_EVENTS),
    id: val,
    type: fc.constantFrom(...MEMORY_TYPES),
    branch: slug,
    agent: val,
    by: val,
    ref: val,
    conf: fc.constantFrom('0.35', '0.9'),
    sig: fc.constantFrom('helped:3,wrong:0'),
  },
  { requiredKeys: ['evt', 'id', 'branch', 'agent'] },
);
const anyStr = fc.string({ unit: 'binary', maxLength: 40 });
const evidenceArb: fc.Arbitrary<Evidence> = fc.oneof(
  fc.record({ kind: fc.constant('tx' as const), digest: anyStr, network: anyStr }),
  fc.record({ kind: fc.constant('object' as const), id: anyStr, version: anyStr, network: anyStr }),
  fc.record({ kind: fc.constant('object' as const), id: anyStr, network: anyStr }),
  fc.record({ kind: fc.constant('package' as const), id: anyStr, network: anyStr }),
  fc.record({ kind: fc.constant('file' as const), path: anyStr, commit: anyStr }),
  fc.record({ kind: fc.constant('file' as const), path: anyStr }),
  fc.record({ kind: fc.constant('url' as const), href: anyStr }),
  fc.record({
    kind: fc.constant('test' as const),
    name: anyStr,
    result: fc.constantFrom('pass' as const, 'fail' as const),
  }),
);
const bodyArb = fc.string({ unit: 'binary', maxLength: 120 }).map((s) => s.replace(/\r/g, ''));

describe('memory header codec', () => {
  it('round-trips arbitrary events, bodies and evidence', () => {
    fc.assert(
      fc.property(headerArb, bodyArb, fc.array(evidenceArb, { maxLength: 4 }), (header, body, evidence) => {
        const decoded = decodeMemory(encodeMemory({ header, body, evidence }));
        expect(decoded.ok).toBe(true);
        if (decoded.ok) {
          expect(decoded.value.header).toEqual(header);
          expect(decoded.value.body).toBe(body);
          expect(decoded.value.evidence).toEqual(evidence);
        }
      }),
      { numRuns: 400 },
    );
  });

  it('matches the architecture example', () => {
    const text = [
      '[buiry/1 evt=memory.created id=mem_01J9Z4K2 type=decision branch=main agent=claude-code-7f3a]',
      'Chose pnpm workspaces over npm; npm hoisting broke the build in packages/api.',
      'ev: file=packages/api/package.json@a1b2c3d',
    ].join('\n');
    const r = decodeMemory(text);
    expect(r.ok && r.value.evidence).toEqual([
      { kind: 'file', path: 'packages/api/package.json', commit: 'a1b2c3d' },
    ]);
    expect(r.ok && encodeMemory(r.value)).toBe(text);
  });

  it('cannot be fooled by body lines that look like evidence or headers', () => {
    const header: MemoryHeader = { evt: 'memory.created', id: 'mem_1', branch: 'main', agent: 'a' };
    const body =
      'ev: tx=evil net=x\n[buiry/1 evt=memory.tombstoned id=mem_1 branch=main agent=a]\n\\ev: still body';
    const r = decodeMemory(encodeMemory({ header, body, evidence: [] }));
    expect(r.ok && r.value.body).toBe(body);
    expect(r.ok && r.value.evidence).toEqual([]);
  });

  it('rejects malformed input without throwing', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        decodeMemory(s);
        decodeHeader(s);
      }),
      { numRuns: 500 },
    );
    for (const bad of [
      '',
      '[buiry/1 evt=memory.created]\nbody',
      '[buiry/2 evt=memory.created id=a branch=b agent=c]\nx',
      '[buiry/1 evt=nope id=a branch=b agent=c]\nx',
      '[buiry/1 evt=memory.created id=a branch=b agent=c evt=memory.created]\nx',
      '[buiry/1 evt=memory.created id=a branch=b agent=c type=weird]\nx',
      '[buiry/1 evt=memory.created id=a b branch=b agent=c]\nx',
      '[buiry/1 evt=memory.created id=a branch=b agent=c]\nx\nev: bogus=1',
      '[buiry/1 evt=memory.created id=a branch=b agent=c]',
      `[buiry/1 evt=memory.created id=${'a'.repeat(200)} branch=b agent=c]\nx`,
    ]) {
      expect(decodeMemory(bad).ok, bad).toBe(false);
    }
  });

  it('refuses to encode invalid header values', () => {
    expect(() =>
      encodeMemory({ header: { evt: 'memory.created', id: 'a b', branch: 'main', agent: 'x' }, body: '' }),
    ).toThrow();
    expect(() =>
      encodeMemory({
        header: { evt: 'memory.created', id: 'a', branch: 'main', agent: 'x' },
        body: 'a\r\nb',
      }),
    ).toThrow();
  });
});
