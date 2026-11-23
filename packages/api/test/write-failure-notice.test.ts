import { describe, expect, it } from 'vitest';
import { WRITE_FAILURES_NOTICE, createDrain, createStack } from '../src/index.js';
import { Clock, startRelayer } from './helpers.js';

// Phase 10 F5: a project gets a notice after 2 consecutive failed writes, whatever the relayer's /health says (seen
// live: health said "ok" for hours while every job failed). It clears on the next stored write. Content-free.

const CAPACITY =
  'The hosted relayer could not complete the durable Walrus upload: temporary capacity limit. See https://support.example.test?ref=SECRET-REF';

describe('F5: notice after consecutive failed writes, independent of relayer health', () => {
  it('appears while health says ok but writes fail, and clears when a write is stored', async () => {
    const c = new Clock();
    const { mock, adapter } = await startRelayer(c);
    const s = await createStack({ now: c.now, adapter });
    try {
      mock.writeState = 'ok'; // the relayer's health says everything is fine
      const ws = await s.newWorkspace('Notice');
      const prj = await s.newProject(ws.id);
      const a = await s.newAgent({
        workspaceId: ws.id,
        projectId: prj.id,
        name: 'claude-code',
        tool: 'claude-code',
      });
      const open = async () =>
        (
          await s.db.system((tx) =>
            tx.query<{ detail: string; severity: string }>(
              `select detail, severity from flags where project_id = $1 and kind = 'write_failures' and state <> 'resolved'`,
              [prj.id],
            ),
          )
        ).rows;
      const briefing = async () => JSON.stringify(await a.backend.check({ task: 'anything' }));

      mock.failNextJobs(2, CAPACITY);
      await a.backend.remember({
        text: 'A decision written while the relayer is at capacity.',
        type: 'decision',
      });
      const drain = createDrain(s.deps, adapter, { backoffBaseMs: 1000, pollIntervalMs: 0 });
      const tick = async (n: number) => {
        for (let i = 0; i < n; i++) {
          await drain.tick();
          c.advance(2000);
        }
      };

      await tick(3); // first attempt fails: one failure is not yet a notice
      expect(await open()).toEqual([]);
      await tick(3); // second consecutive failure: the notice appears
      expect(await open()).toEqual([{ detail: WRITE_FAILURES_NOTICE, severity: 'warning' }]);
      expect(await briefing()).toContain(WRITE_FAILURES_NOTICE);
      for (const leak of ['SECRET', 'support.example', 'capacity limit. See'])
        expect(WRITE_FAILURES_NOTICE).not.toContain(leak);

      await tick(6); // the third attempt is stored: the notice clears
      expect(await open()).toEqual([]);
      expect(await briefing()).not.toContain(WRITE_FAILURES_NOTICE);
    } finally {
      await s.close();
      await mock.close();
    }
  });
});
