// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DEFAULT_LEARNING,
  MEMORY_TYPES,
  applySignal,
  confidenceBand,
  effectiveConfidence,
  findConflictCandidates,
  initialState,
  needsReview,
  surfaceFailures,
  type Actor,
  type LearningState,
  type MemoryRecord,
} from '../src/index.js';

const T0 = Date.parse('2026-10-11T10:00:00Z');
const DAY = 86_400_000;
const agentA: Actor = { kind: 'agent', id: 'claude-code-7f3a', sessionId: 's1' };
const agentB: Actor = { kind: 'agent', id: 'opencode-91c2', sessionId: 's2' };
const agentC: Actor = { kind: 'agent', id: 'cursor-4be0', sessionId: 's3' };
const human: Actor = { kind: 'human', id: 'amara' };

const fresh = (type: 'decision' | 'deployment' = 'decision'): LearningState =>
  initialState({ id: 'mem_1', type, actor: agentA, at: T0 });

describe('initial confidence', () => {
  it('agent 0.35 proposed; human 0.80 confirmed; verified evidence adds 0.25 capped at 0.90', () => {
    expect(fresh().confidence).toBe(0.35);
    expect(fresh().status).toBe('proposed');
    const h = initialState({ id: 'm', type: 'fact', actor: human, at: T0 });
    expect([h.confidence, h.status]).toEqual([0.8, 'confirmed']);
    expect(
      initialState({ id: 'm', type: 'deployment', actor: agentA, at: T0, evidenceVerified: true }).confidence,
    ).toBe(0.6);
    expect(
      initialState({ id: 'm', type: 'deployment', actor: human, at: T0, evidenceVerified: true }).confidence,
    ).toBe(0.9);
  });
});

describe('signals', () => {
  it('helpful report by agent is weighted 0.5, by human 1.0', () => {
    const a = applySignal(fresh(), { kind: 'report', actor: agentB, outcome: 'helped' }, T0);
    expect(a.state.confidence).toBeCloseTo(0.35 + 0.65 * 0.08 * 0.5, 3);
    const h = applySignal(fresh(), { kind: 'report', actor: human, outcome: 'helped' }, T0);
    expect(h.state.confidence).toBeCloseTo(0.35 + 0.65 * 0.08, 3);
  });
  it('caps helpful reinforcement at two per memory per day', () => {
    let s = fresh();
    s = applySignal(s, { kind: 'report', actor: agentB, outcome: 'helped' }, T0).state;
    s = applySignal(s, { kind: 'report', actor: agentC, outcome: 'helped' }, T0 + 1000).state;
    const third = applySignal(s, { kind: 'report', actor: agentB, outcome: 'helped' }, T0 + 2000);
    expect(third.applied).toBe(false);
    expect(third.state.confidence).toBe(s.confidence);
    expect(applySignal(s, { kind: 'report', actor: agentB, outcome: 'helped' }, T0 + DAY).applied).toBe(true);
  });
  it('wrong halves confidence; second wrong contests', () => {
    let s = applySignal(fresh(), { kind: 'report', actor: agentB, outcome: 'wrong' }, T0).state;
    expect(s.confidence).toBeCloseTo(0.175, 3);
    expect(s.status).toBe('proposed');
    s = applySignal(s, { kind: 'report', actor: agentC, outcome: 'wrong' }, T0 + 1).state;
    expect(s.status).toBe('contested');
  });
  it('irrelevant changes nothing but is recorded', () => {
    const r = applySignal(fresh(), { kind: 'report', actor: agentB, outcome: 'irrelevant' }, T0);
    expect(r.state.confidence).toBe(0.35);
    expect(r.state.history).toHaveLength(1);
  });
  it('verification pass reinforces and resets decay; fail marks stale and x0.4', () => {
    const pass = applySignal(fresh('deployment'), { kind: 'verify', result: 'pass' }, T0 + 10 * DAY);
    expect(pass.state.confidence).toBeCloseTo(0.35 + 0.65 * 0.05, 3);
    expect(pass.state.lastReinforcedAt).toBe(T0 + 10 * DAY);
    const fail = applySignal(fresh('deployment'), { kind: 'verify', result: 'fail' }, T0);
    expect([fail.state.status, fail.state.confidence]).toEqual(['stale', 0.14]);
  });
  it('contest x0.7 sets contested', () => {
    const r = applySignal(fresh(), { kind: 'contest', actor: human }, T0);
    expect([r.state.status, r.state.confidence]).toEqual(['contested', 0.245]);
  });
  it('only people confirm; agents cannot (no self-promotion)', () => {
    expect(applySignal(fresh(), { kind: 'confirm', actor: agentA }, T0).applied).toBe(false);
    expect(applySignal(fresh(), { kind: 'confirm', actor: agentB }, T0).applied).toBe(false);
    const ok = applySignal(fresh(), { kind: 'confirm', actor: human }, T0);
    expect([ok.state.status, ok.state.confidence]).toEqual(['confirmed', 0.8]);
  });
  it('terminal statuses ignore reinforcement', () => {
    const t = applySignal(fresh(), { kind: 'tombstone' }, T0).state;
    expect(applySignal(t, { kind: 'report', actor: human, outcome: 'helped' }, T0).applied).toBe(false);
    expect(applySignal(t, { kind: 'confirm', actor: human }, T0).applied).toBe(false);
  });
  it('records an explained history', () => {
    const s = applySignal(fresh(), { kind: 'report', actor: agentB, outcome: 'helped' }, T0).state;
    expect(s.history[0]).toMatchObject({ signal: 'report.helped', before: 0.35, statusBefore: 'proposed' });
  });
});

describe('auto-promotion', () => {
  const cfg = DEFAULT_LEARNING;
  it('promotes after 3 helpful reports from 2 distinct non-creating sessions with no wrong signals', () => {
    let s = fresh();
    const day = (n: number) => T0 + n * DAY;
    s = applySignal(s, { kind: 'report', actor: agentB, outcome: 'helped' }, day(0)).state;
    s = applySignal(s, { kind: 'report', actor: agentB, outcome: 'helped' }, day(0) + 1).state;
    expect(s.status).toBe('proposed');
    const r = applySignal(s, { kind: 'report', actor: agentC, outcome: 'helped' }, day(1));
    expect(r.state.status).toBe('confirmed');
    expect(r.reason).toMatch(/auto-promoted/);
    expect(r.state.confidence).toBeGreaterThanOrEqual(cfg.humanFloor);
  });
  it('does not count the creating session toward its own promotion', () => {
    let s = fresh();
    for (let d = 0; d < 4; d++)
      s = applySignal(s, { kind: 'report', actor: agentA, outcome: 'helped' }, T0 + d * DAY).state;
    expect(s.status).toBe('proposed');
    expect(s.promotionReports).toBe(0);
  });
  it('a single other session is not enough', () => {
    let s = fresh();
    for (let d = 0; d < 4; d++)
      s = applySignal(s, { kind: 'report', actor: agentB, outcome: 'helped' }, T0 + d * DAY).state;
    expect(s.status).toBe('proposed');
  });
  it('can be disabled and is blocked by a wrong report', () => {
    const off = { ...cfg, promotion: { ...cfg.promotion, enabled: false } };
    let s = fresh();
    for (const [i, a] of [agentB, agentC, agentB, agentC].entries())
      s = applySignal(s, { kind: 'report', actor: a, outcome: 'helped' }, T0 + i * DAY, off).state;
    expect(s.status).toBe('proposed');
    let w = applySignal(fresh(), { kind: 'report', actor: agentB, outcome: 'wrong' }, T0).state;
    for (const [i, a] of [agentB, agentC, agentB, agentC].entries())
      w = applySignal(w, { kind: 'report', actor: a, outcome: 'helped' }, T0 + (i + 1) * DAY).state;
    expect(w.status).toBe('proposed');
  });
});

describe('decay', () => {
  it('halves at the per-type half-life', () => {
    for (const type of MEMORY_TYPES) {
      const s = { confidence: 0.8, type, lastReinforcedAt: T0 };
      const h = DEFAULT_LEARNING.halfLifeDays[type];
      expect(effectiveConfidence(s, T0 + h * DAY)).toBeCloseTo(0.4, 6);
      expect(effectiveConfidence(s, T0)).toBe(0.8);
    }
  });
  it('is monotonically non-increasing in time, bounded, and never raises status', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.constantFrom(...MEMORY_TYPES),
        fc.nat(2000),
        fc.nat(2000),
        (c, type, d1, d2) => {
          const s = { confidence: c, type, lastReinforcedAt: T0 };
          const [a, b] = d1 <= d2 ? [d1, d2] : [d2, d1];
          const ea = effectiveConfidence(s, T0 + a * DAY);
          const eb = effectiveConfidence(s, T0 + b * DAY);
          expect(eb).toBeLessThanOrEqual(ea + 1e-12);
          expect(ea).toBeLessThanOrEqual(c + 1e-12);
          expect(eb).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });
  it('clock skew (now before reinforcement) does not boost', () => {
    expect(effectiveConfidence({ confidence: 0.5, type: 'fact', lastReinforcedAt: T0 }, T0 - DAY)).toBe(0.5);
  });
  it('needs-review flag appears with age but status is untouched', () => {
    const s = { ...fresh('deployment'), status: 'confirmed' as const, confidence: 0.8 };
    expect(needsReview(s, T0)).toBe(false);
    expect(needsReview(s, T0 + 120 * DAY)).toBe(true);
  });
  it('confidence stays within [0,1] under any signal sequence', () => {
    const sig = fc.constantFrom<'helped' | 'wrong' | 'irrelevant' | 'outdated'>(
      'helped',
      'wrong',
      'irrelevant',
      'outdated',
    );
    fc.assert(
      fc.property(fc.array(fc.tuple(sig, fc.nat(30)), { maxLength: 40 }), (seq) => {
        let s = fresh();
        for (const [o, d] of seq) {
          s = applySignal(
            s,
            { kind: 'report', actor: d % 2 ? agentB : human, outcome: o },
            T0 + d * DAY,
          ).state;
          expect(s.confidence).toBeGreaterThanOrEqual(0);
          expect(s.confidence).toBeLessThanOrEqual(1);
        }
      }),
    );
  });
  it('bands', () => {
    expect([0.39, 0.4, 0.7, 0.71].map(confidenceBand)).toEqual(['low', 'medium', 'medium', 'high']);
  });
});

const rec = (
  id: string,
  type: MemoryRecord['type'],
  text: string,
  status: MemoryRecord['status'] = 'confirmed',
): MemoryRecord => ({
  id,
  type,
  text,
  status,
  branch: 'main',
  confidence: 0.8,
  agent: 'a',
  createdAt: T0,
  updatedAt: T0,
  lastReinforcedAt: T0,
  evidence: [],
});

describe('conflict candidates and failure surfacing', () => {
  const existing = [
    rec('mem_a', 'decision', 'Store sessions in the database.'),
    rec('mem_b', 'decision', 'Use pnpm workspaces; npm hoisting broke the build.'),
    rec('mem_c', 'decision', 'Store sessions in the database.', 'superseded'),
    rec('mem_d', 'failure', 'Store sessions in the database failed under load.'),
  ];
  it('returns similar same-class memories and never changes status', () => {
    const c = findConflictCandidates({ text: 'Store sessions in Redis.', type: 'decision' }, existing);
    expect(c.map((x) => x.memoryId)).toEqual(['mem_a']);
    expect(existing[0]!.status).toBe('confirmed');
  });
  it('skips non-comparable types', () => {
    expect(
      findConflictCandidates({ text: 'Store sessions in the database.', type: 'failure' }, existing),
    ).toEqual([]);
  });
  it('surfaces failures similar to the task first', () => {
    const fs = [
      rec('f1', 'failure', 'Running the migration in one transaction exceeded the gas limit.'),
      rec('f2', 'failure', 'CSS build crashes on Windows paths.'),
      rec('d1', 'decision', 'Run migrations in batches.'),
    ];
    const r = surfaceFailures('write a migration for the users table in one transaction', fs);
    expect(r.map((x) => x.memory.id)).toEqual(['f1']);
  });
});

describe('delegated confirmation (agent token with the confirm scope)', () => {
  it('lets another agent confirm but never the creator, and never without delegation', () => {
    const s = initialState({ id: 'mem_1', type: 'decision', actor: agentA, at: T0 });
    expect(applySignal(s, { kind: 'confirm', actor: agentB, delegated: true }, T0).state.status).toBe(
      'confirmed',
    );
    expect(applySignal(s, { kind: 'confirm', actor: agentA, delegated: true }, T0).applied).toBe(false);
    expect(applySignal(s, { kind: 'confirm', actor: agentB }, T0).applied).toBe(false);
  });
});
