import { describe, expect, it } from 'vitest';
import { createDrain, createStack } from '../src/index.js';
import { Clock, startRelayer } from './helpers.js';

// Phase 10: the server's write drain logs each relayer job id and status change through deps.eventLog, content-free,
// so a failed write can be traced with Walrus support.

describe('write drain job-id logging', () => {
  it('logs relayer job ids and statuses through deps.eventLog, without memory text or namespace', async () => {
    const c = new Clock();
    const { mock, adapter } = await startRelayer(c);
    const s = await createStack({ now: c.now, adapter });
    const lines: string[] = [];
    s.deps.eventLog = (l) => void lines.push(l);
    try {
      const ws = await s.newWorkspace('Logged');
      const prj = await s.newProject(ws.id);
      const a = await s.newAgent({
        workspaceId: ws.id,
        projectId: prj.id,
        name: 'claude-code',
        tool: 'claude-code',
      });
      const m = await a.backend.remember({ text: 'MARKER-TEXT-4417 stays out of logs.', type: 'decision' });
      const drain = createDrain(s.deps, adapter);
      for (let i = 0; i < 5; i++) {
        await drain.tick();
        c.advance(3000);
      }
      const jobs = lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((l) => l.event === 'write_job');
      expect(jobs.map((j) => j.status)).toEqual(expect.arrayContaining(['submitted', 'stored']));
      for (const j of jobs) {
        expect(typeof j.relayerJob).toBe('string');
        expect(j.memory).toBe(m.memoryId);
        expect(j.project).toBe(prj.id);
      }
      const all = lines.join('\n');
      expect(all).not.toContain('MARKER-TEXT-4417');
      expect(all).not.toMatch(/buiry\.v1\./);
    } finally {
      await s.close();
      await mock.close();
    }
  });
});
