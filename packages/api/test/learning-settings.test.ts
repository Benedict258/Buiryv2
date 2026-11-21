import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_LEARNING } from '@buiry/core';
import { Clock, createStack, type Stack } from './helpers.js';
import { learningFor } from '../src/index.js';

let stack: Stack;
const clock = new Clock();
beforeAll(async () => {
  stack = await createStack({ now: clock.now });
}, 60_000);
afterAll(async () => stack.close());

const setSettings = (projectId: string, settings: Record<string, unknown>) =>
  stack.db.system((tx) =>
    tx.query(`update projects set settings = settings || $1::jsonb where id = $2`, [
      JSON.stringify(settings),
      projectId,
    ]),
  );

async function setup() {
  const ws = await stack.newWorkspace();
  const prj = await stack.newProject(ws.id);
  const mk = (name: string) => stack.newAgent({ workspaceId: ws.id, projectId: prj.id, name, tool: name });
  return { ws, prj, a: await mk('claude-code'), b: await mk('opencode'), c: await mk('cursor') };
}

describe('learningFor', () => {
  it('overlays valid project settings and ignores invalid ones', () => {
    const deps = stack.deps;
    expect(learningFor(deps, undefined)).toEqual(DEFAULT_LEARNING);
    const cfg = learningFor(deps, {
      autoPromotion: { enabled: false, helpfulReports: 1, distinctSessions: 'x' },
      halfLives: { fact: 2, unknown_type: 5, decision: -3 },
      reviewThreshold: 0.5,
    });
    expect(cfg.promotion).toEqual({
      enabled: false,
      helpfulReports: 1,
      distinctSessions: DEFAULT_LEARNING.promotion.distinctSessions,
    });
    expect(cfg.halfLifeDays.fact).toBe(2);
    expect(cfg.halfLifeDays.decision).toBe(DEFAULT_LEARNING.halfLifeDays.decision);
    expect('unknown_type' in cfg.halfLifeDays).toBe(false);
    expect(cfg.reviewThreshold).toBe(0.5);
    expect(DEFAULT_LEARNING.promotion.enabled).toBe(true); // the default object is never mutated
  });
});

describe('project learning settings are applied', () => {
  it('a shorter half-life makes a memory decay faster', async () => {
    const { prj, a } = await setup();
    await setSettings(prj.id, { halfLives: { fact: 1 } });
    const other = await setup();
    const slow = await other.a.backend.remember({
      text: 'The staging database is reset nightly.',
      type: 'fact',
    });
    const fast = await a.backend.remember({ text: 'The staging database is reset nightly.', type: 'fact' });
    clock.advance(10 * 86_400_000);
    const eff = async (be: typeof a.backend, q: string, id: string) =>
      (await be.recall({ query: q })).results.find((r) => r.memoryId === id)!.confidence;
    const q = 'staging database reset';
    expect(await eff(a.backend, q, fast.memoryId)).toBeLessThan(await eff(other.a.backend, q, slow.memoryId));
  });

  it('promotion thresholds come from the project, but reports never confirm (M8); off stays proposed too', async () => {
    const { prj, a, b, c } = await setup();
    await setSettings(prj.id, { autoPromotion: { enabled: true, helpfulReports: 1, distinctSessions: 1 } });
    const m = await a.backend.remember({ text: 'Prefer small pull requests.', type: 'preference' });
    const first = await b.backend.report({ memoryId: m.memoryId, outcome: 'helped' });
    expect(first.status).toBe('proposed');
    expect(first.reason).toMatch(/ready for a person to confirm/); // the project's threshold of 1 is applied

    const off = await setup();
    await setSettings(off.prj.id, { autoPromotion: { enabled: false } });
    const m2 = await off.a.backend.remember({
      text: 'Prefer strict TypeScript everywhere.',
      type: 'preference',
    });
    await off.b.backend.report({ memoryId: m2.memoryId, outcome: 'helped' });
    clock.advance(86_400_000);
    await off.c.backend.report({ memoryId: m2.memoryId, outcome: 'helped' });
    clock.advance(86_400_000);
    const r = await off.b.backend.report({ memoryId: m2.memoryId, outcome: 'helped' });
    expect(r.status).toBe('proposed');
    void c;
  });
});
