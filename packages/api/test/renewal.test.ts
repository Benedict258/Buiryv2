import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BuiryError } from '@buiry/core';
import type { MockRelayer, WalrusMemoryAdapter } from '@buiry/storage';
import { Clock, createDrain, createStack, startRelayer, type Stack } from './helpers.js';
import { queueRenewals, renewMemories, rewriteRenewer, type UserPrincipal } from '../src/index.js';

// Phase 6: renewal by rewrite. The memory keeps its old blob until the rewrite is stored, then moves to the new one.

const clock = new Clock();
let s: Stack;
let mock: MockRelayer;
let adapter: WalrusMemoryAdapter;
let ws: string;
let project: string;
let agent: Awaited<ReturnType<Stack['newAgent']>>;

const row = async (id: string) =>
  (
    await s.db.system((tx) =>
      tx.query<{
        walrus_blob_id: string;
        previous_blob_id: string | null;
        renewal_generation: number;
        expired: boolean;
      }>('select walrus_blob_id, previous_blob_id, renewal_generation, expired from memories where id = $1', [
        id,
      ]),
    )
  ).rows[0]!;
const jobsFor = async (id: string) =>
  (
    await s.db.system((tx) =>
      tx.query<{ idempotency_key: string; state: string }>(
        'select idempotency_key, state from write_jobs where memory_id = $1 order by created_at',
        [id],
      ),
    )
  ).rows;
const drainAll = async () => {
  const d = createDrain(s.deps, adapter, { pollIntervalMs: 0, backoffBaseMs: 0 });
  for (let i = 0; i < 4; i++) {
    await d.tick();
    clock.advance(3000);
  }
};
const stored = async (text: string) => {
  clock.advance(61_000); // stay under the agent write budget (6 a minute)
  const m = await agent.backend.remember({ text, type: 'decision' });
  await drainAll();
  return m.memoryId;
};
const user = (role: UserPrincipal['role']): UserPrincipal => ({
  kind: 'user',
  workspaceId: ws,
  userId: `usr_${role}`,
  displayName: role,
  role,
  projectScope: null,
});

beforeAll(async () => {
  const r = await startRelayer(clock);
  mock = r.mock;
  adapter = r.adapter;
  s = await createStack({ now: clock.now, adapter, renewalEnabled: true });
  ws = (await s.newWorkspace()).id;
  project = (await s.newProject(ws)).id;
  agent = await s.newAgent({ workspaceId: ws, projectId: project, name: 'r', tool: 'claude-code' });
}, 60_000);
afterAll(async () => {
  await s.close();
  await mock.close();
});

describe('renewal by rewrite', () => {
  it('rewrites the stored text under a generation key, once, and switches blobs only when the rewrite is stored', async () => {
    const id = await stored('Renewal subject: keep the API on port 8787.');
    const first = await row(id);
    const blobsBefore = mock.blobs.length;

    expect(await queueRenewals(s.deps, [id])).toEqual({ queued: [id], failed: [] });
    expect((await queueRenewals(s.deps, [id])).queued).toEqual([id]); // repeated scan: same generation, no new job
    const keys = (await jobsFor(id)).map((j) => j.idempotency_key);
    expect(keys.filter((k) => k.endsWith('.r1'))).toHaveLength(1);
    expect((await row(id)).walrus_blob_id).toBe(first.walrus_blob_id); // still the old blob

    await drainAll();
    const after = await row(id);
    expect(after.walrus_blob_id).not.toBe(first.walrus_blob_id);
    expect(after.previous_blob_id).toBe(first.walrus_blob_id);
    expect(after.renewal_generation).toBe(1);
    expect(mock.blobs).toHaveLength(blobsBefore + 1);
    const oldBlob = mock.blobs.find((b) => b.blobId === first.walrus_blob_id)!;
    const newBlob = mock.blobs.find((b) => b.blobId === after.walrus_blob_id)!;
    expect(oldBlob).toBeTruthy(); // the old blob is untouched
    expect(newBlob.text).toBe(oldBlob.text); // exact same stored text
    const ev = await s.db.system((tx) =>
      tx.query<{ walrus_blob_id: string; payload: { previousBlobId: string; generation: number } }>(
        `select walrus_blob_id, payload from memory_events where memory_id = $1 and type = 'memory.renewed'`,
        [id],
      ),
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]).toMatchObject({
      walrus_blob_id: after.walrus_blob_id,
      payload: { previousBlobId: first.walrus_blob_id, generation: 1 },
    });

    // The next generation keys off the original key, not the previous suffix.
    await queueRenewals(s.deps, [id]);
    const keys2 = (await jobsFor(id)).map((j) => j.idempotency_key);
    expect(keys2.some((k) => k.endsWith('.r2') && !k.includes('.r1'))).toBe(true);
    await drainAll();
    expect((await row(id)).renewal_generation).toBe(2);
  });

  it('keeps the old blob when the rewrite fails', async () => {
    const id = await stored('Renewal subject: failure keeps the old blob.');
    const first = await row(id);
    mock.failNextWrites(1, 400, 'bad request'); // a client error is not retried
    await queueRenewals(s.deps, [id]);
    await drainAll();
    const now = await row(id);
    expect(now.walrus_blob_id).toBe(first.walrus_blob_id);
    expect(now.renewal_generation).toBe(0);
    expect(now.expired).toBe(false);
  });

  it('maps expiring blob ids to memories for the expiry scan', async () => {
    const id = await stored('Renewal subject: renewer from the expiry scan.');
    const blob = (await row(id)).walrus_blob_id;
    const res = await rewriteRenewer(s.deps).renew([blob, 'unknown-blob']);
    expect(res).toEqual({ renewed: [blob], failed: ['unknown-blob'] });
  });

  it('is behind the flag and limited to writers of the project', async () => {
    const id = await stored('Renewal subject: permissions.');
    const code = (p: Promise<unknown>) =>
      p.then(
        () => 'ok',
        (e) => (e instanceof BuiryError ? e.code : 'other'),
      );
    expect(
      await code(s.db.tenant(ws, (tx) => renewMemories(s.deps, tx, user('reader'), project, [id]))),
    ).toBe('forbidden');
    const ok = await s.db.tenant(ws, (tx) =>
      renewMemories(s.deps, tx, user('writer'), project, [id, 'mem_nope']),
    );
    expect(ok.queued).toEqual([id]);
    expect(ok.failed).toEqual([{ memoryId: 'mem_nope', reason: 'not in this project' }]);
    s.deps.renewalEnabled = false;
    try {
      expect(
        await code(s.db.tenant(ws, (tx) => renewMemories(s.deps, tx, user('owner'), project, [id]))),
      ).toBe('invalid_input');
    } finally {
      s.deps.renewalEnabled = true;
    }
  });
});
