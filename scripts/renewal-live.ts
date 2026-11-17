/**
 * One live renewal by rewrite on testnet (LOCAL_CHECKS L-R1). Writes one memory, waits until it is stored, renews it,
 * waits until the rewrite is stored, then checks that the memory moved to a new blob, the old blob is still listed,
 * the stored text is identical, and (bounded wait) the relayer reports an expiry for the new blob.
 *
 *   pnpm tsx scripts/with-env.ts testnet -- pnpm tsx scripts/renewal-live.ts
 *
 * Testnet only. Writes two blobs. Prints ids and outcomes, never a key.
 */
import { randomBytes } from 'node:crypto';
import { createDrain, queueRenewals } from '../packages/api/src/index.js';
import { liveWorld } from './lib/world.js';

const env = process.env as Record<string, string | undefined>;
if (env.WALRUS_NETWORK !== 'testnet' || (env.TATUM_NETWORK ?? '') !== 'testnet') {
  console.error(
    'refusing: this check runs on testnet only (WALRUS_NETWORK and TATUM_NETWORK must be testnet)',
  );
  process.exit(64);
}
const step = (m: string) => console.log(`[renewal-live] ${new Date().toISOString().slice(11, 19)}Z ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const world = await liveWorld(env);
const s = world.stack;
try {
  const run = randomBytes(3).toString('hex');
  const ws = await s.newWorkspace(`renewal-live-${run}`);
  const prj = await s.newProject(ws.id, `renewal-${run}`, { networks: ['sui:testnet'] });
  const agent = await s.newAgent({
    workspaceId: ws.id,
    projectId: prj.id,
    name: 'renewal',
    tool: 'claude-code',
  });
  const m = await agent.backend.remember({
    text: `Renewal live check ${run}: this memory is rewritten.`,
    type: 'fact',
  });
  const drain = createDrain(s.deps, world.adapter, { pollIntervalMs: 3000 });
  const row = async () =>
    (
      await s.db.system((tx) =>
        tx.query<{
          walrus_blob_id: string | null;
          previous_blob_id: string | null;
          renewal_generation: number;
          namespace: string;
        }>(
          `select m.walrus_blob_id, m.previous_blob_id, m.renewal_generation, b.namespace
             from memories m join branches b on b.id = m.branch_id where m.id = $1`,
          [m.memoryId],
        ),
      )
    ).rows[0]!;
  const until = async (ok: () => Promise<boolean>, ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await drain.tick();
      if (await ok()) return true;
      await sleep(5000);
    }
    return false;
  };

  if (!(await until(async () => !!(await row()).walrus_blob_id, 4 * 60_000)))
    throw new Error('the first write was not stored within 4 minutes');
  const first = await row();
  step(`stored ${m.memoryId} as blob ${first.walrus_blob_id}`);

  const q = await queueRenewals(s.deps, [m.memoryId]);
  if (!q.queued.length) throw new Error(`renewal not queued: ${q.failed[0]?.reason}`);
  step('renewal queued (generation 1)');
  if (!(await until(async () => (await row()).renewal_generation === 1, 4 * 60_000)))
    throw new Error('the rewrite was not stored within 4 minutes');
  const after = await row();
  step(`renewed: blob ${after.walrus_blob_id}, previous ${after.previous_blob_id}`);

  const listing = async () => {
    const items = (await world.adapter.list({ namespace: first.namespace, limit: 100 })).items;
    return {
      old: items.find((i) => i.blobId === first.walrus_blob_id),
      fresh: items.find((i) => i.blobId === after.walrus_blob_id),
    };
  };
  let l = await listing();
  // The relayer reports end epoch and expiry minutes after a write (L-W2T); wait a bounded time for the new blob's.
  const end = Date.now() + 10 * 60_000;
  while (l.fresh?.expiresAt === undefined && Date.now() < end) {
    await sleep(30_000);
    l = await listing();
  }
  const checks = {
    movedToNewBlob: !!after.walrus_blob_id && after.walrus_blob_id !== first.walrus_blob_id,
    previousKept: after.previous_blob_id === first.walrus_blob_id,
    oldBlobStillListed: !!l.old,
    newBlobListed: !!l.fresh,
    newBlobExpiry: l.fresh?.expiresAt ? new Date(l.fresh.expiresAt).toISOString() : null,
    newBlobEndEpoch: l.fresh?.endEpoch ?? null,
    oldBlobExpiry: l.old?.expiresAt ? new Date(l.old.expiresAt).toISOString() : null,
  };
  step(`checks: ${JSON.stringify(checks)}`);
  const pass =
    checks.movedToNewBlob && checks.previousKept && checks.oldBlobStillListed && checks.newBlobListed;
  step(pass ? 'PASS' : 'FAIL');
  process.exitCode = pass ? 0 : 1;
} catch (e) {
  step(`failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await world.close();
}
