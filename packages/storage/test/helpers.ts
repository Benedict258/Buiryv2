import { encodeMemory, newId, type MemoryHeader, type MemoryType } from '@buiry/core';

export class Clock {
  constructor(public t = Date.parse('2026-10-20T10:00:00Z')) {}
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const bytes = (n: number) => Uint8Array.from({ length: n }, () => Math.floor(next() * 256));
  return { next, bytes };
}

export const PROJECT = 'prj_01J9Z3ABCDEFGH';

export function memText(
  id: string,
  body: string,
  o: { type?: MemoryType; branch?: string; agent?: string; evt?: MemoryHeader['evt'] } = {},
) {
  const header: MemoryHeader = {
    evt: o.evt ?? 'memory.created',
    id,
    type: o.type ?? 'decision',
    branch: o.branch ?? 'main',
    agent: o.agent ?? 'claude-code-7f3a',
  };
  const text = encodeMemory({ header, body });
  return { header: text.split('\n', 1)[0]!, text };
}

export function jobInput(i: number, o: { agent?: string; project?: string; namespace?: string } = {}) {
  const r = rng(i + 1);
  const id = newId('mem', 1_000 + i, r.bytes);
  const { header, text } = memText(id, `Decision number ${i} about workspace layout.`);
  return {
    memoryId: id,
    namespace: o.namespace ?? `buiry.v1.${PROJECT}.main`,
    projectId: o.project ?? PROJECT,
    agentId: o.agent ?? 'claude-code-7f3a',
    header,
    text,
  };
}
