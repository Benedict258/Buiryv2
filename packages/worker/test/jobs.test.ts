import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FIXTURES_DIR,
  GrpcBackend,
  MockTatum,
  TatumGateway,
  loadFixtures,
} from '@buiry/chain';
import { EPOCH_MS, Ed25519Signer, HttpWalrusAdapter, MockRelayer } from '@buiry/storage';
import { createDrain, createStack, type UserPrincipal } from '@buiry/api';
import {
  Scheduler,
  driftScan,
  expiryScan,
  isolationCanary,
  relayerProbe,
  snapshotRegen,
} from '../src/index.js';
import ids from '../../chain/fixtures/_ids.json' with { type: 'json' };

class Clock {
  t = Date.parse('2026-10-20T10:00:00Z');
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}
const rand = (n: number) => new Uint8Array(randomBytes(n));
const admin = (workspaceId: string): UserPrincipal => ({
  kind: 'user',
  workspaceId,
  userId: 'usr_admin',
  displayName: 'Amara',
  role: 'admin',
  projectScope: null,
});

async function world(opts: { relayer?: object; gateway?: boolean } = {}) {
  const c = new Clock();
  const mock = await MockRelayer.start({
    now: c.now,
    autoCompleteMs: 0,
    defaultEpochs: 3,
    ...(opts.relayer ?? {}),
  });
  const adapter = new HttpWalrusAdapter({
    baseUrl: mock.url,
    accountId: '0xacct',
    signer: new Ed25519Signer('55'.repeat(32)),
    now: c.now,
  });
  let tatum: MockTatum | undefined;
  let gateway: TatumGateway | undefined;
  if (opts.gateway) {
    tatum = await MockTatum.start(
      { apiKey: 'k' },
      loadFixtures(FIXTURES_DIR).filter((f) => f.network === 'sui:mainnet'),
    );
    gateway = new TatumGateway({
      backends: {
        'sui:mainnet': [
          new GrpcBackend({ endpoint: tatum.grpcEndpoint, apiKey: 'k', insecure: true, deadlineMs: 2000 }),
        ],
      },
      defaultNetwork: 'sui:mainnet',
      now: c.now,
      sleep: async () => {},
      requestsPerSecond: 1000,
      maxRetries: 0,
    });
  }
  const stack = await createStack({ now: c.now, random: rand, adapter, ...(gateway ? { gateway } : {}) });
  const ws = await stack.newWorkspace();
  const prj = await stack.newProject(ws.id);
  const agent = await stack.newAgent({
    workspaceId: ws.id,
    projectId: prj.id,
    name: 'claude-code',
    tool: 'claude-code',
  });
  const drain = createDrain(stack.deps, adapter);
  const settle = async (n = 4) => {
    for (let i = 0; i < n; i++) {
      await drain.tick();
      c.advance(3000);
    }
  };
  return {
    c,
    mock,
    adapter,
    stack,
    ws,
    prj,
    agent,
    drain,
    settle,
    close: async () => {
      gateway?.close();
      await tatum?.close();
      await stack.close();
      await mock.close();
    },
  };
}
const row = async (w: Awaited<ReturnType<typeof world>>, id: string) =>
  (
    await w.stack.db.system((tx) =>
      tx.query<Record<string, unknown>>('select * from memories where id = $1', [id]),
    )
  ).rows[0]!;

describe('expiry scan', () => {
  it('records expiry, flags memories inside the margin, marks lapsed ones expired, and clears flags after renewal', async () => {
    const w = await world();
    const m = await w.agent.backend.remember({
      text: 'Registry deployment notes for mainnet.',
      type: 'deployment',
    });
    await w.settle();
    const opts = { adapter: w.adapter, checkIntervalMs: 6 * 3_600_000 };

    let rep = await expiryScan(w.stack.deps, opts);
    expect(rep).toMatchObject({ projects: 1, expiring: 0, expired: 0 });
    expect((await row(w, m.memoryId)).expires_at).toBeTruthy(); // recorded from the read interface

    w.c.advance(EPOCH_MS * 1.2); // inside the two-epoch margin
    rep = await expiryScan(w.stack.deps, opts);
    expect(rep.expiring).toBe(1);
    const fl = await w.stack.db.system((tx) =>
      tx.query<{ severity: string; detail: string }>(
        `select severity, detail from flags where memory_id = $1 and kind = 'expiring'`,
        [m.memoryId],
      ),
    );
    expect(fl.rows[0]).toMatchObject({ severity: 'warning' });
    expect(fl.rows[0]!.detail).toMatch(/expires \d{4}-\d{2}-\d{2}/);
    const chk = await w.agent.backend.check({});
    expect(chk.flags).toContainEqual(expect.objectContaining({ memoryId: m.memoryId, kind: 'expiring' }));

    w.c.advance(EPOCH_MS * 3);
    rep = await expiryScan(w.stack.deps, opts);
    expect(rep.expired).toBe(1);
    expect((await row(w, m.memoryId)).expired).toBe(true);
    expect((await w.agent.backend.recall({ query: 'registry deployment notes' })).results).toEqual([]);
    expect((await w.agent.backend.getMemory(m.memoryId)).status).toBe('proposed'); // expiry is a storage property, not a status
    await w.close();
  }, 120_000);

  it('renewal is only attempted behind the feature flag and resolves the warning', async () => {
    const w = await world({ relayer: { defaultEpochs: 1 } });
    const m = await w.agent.backend.remember({ text: 'Short lived memory about caching.', type: 'fact' });
    await w.settle();
    const calls: string[][] = [];
    const renewer = { renew: async (b: string[]) => (calls.push(b), { renewed: b, failed: [] as string[] }) };
    await expiryScan(w.stack.deps, { adapter: w.adapter, checkIntervalMs: 3_600_000, renewer });
    expect(calls).toEqual([]);
    const flagged = await w.stack.db.system((tx) =>
      tx.query(`select 1 from flags where memory_id = $1 and kind = 'expiring' and state <> 'resolved'`, [
        m.memoryId,
      ]),
    );
    expect(flagged.rows).toHaveLength(1);
    const rep = await expiryScan(w.stack.deps, {
      adapter: w.adapter,
      checkIntervalMs: 3_600_000,
      renewer,
      renewalEnabled: true,
    });
    expect(calls).toHaveLength(1);
    expect(rep.renewed).toBe(1);
    const left = await w.stack.db.system((tx) =>
      tx.query(`select 1 from flags where memory_id = $1 and kind = 'expiring' and state <> 'resolved'`, [
        m.memoryId,
      ]),
    );
    expect(left.rows).toHaveLength(0);
    await w.close();
  }, 120_000);
});

describe('drift scan', () => {
  it('marks a deployment stale after an upgrade, bounded to recalled-first priority, and skips when the gateway is degraded', async () => {
    const w = await world({ gateway: true });
    const dep = await w.agent.backend.remember({
      text: `Registry package deployed at ${ids.PKG_V3}, version 3.`,
      type: 'deployment',
      evidence: [{ kind: 'package', id: ids.PKG_V3, network: 'sui:mainnet' }],
    });
    const other = await w.agent.backend.remember({
      text: 'Registry object pinned at version seven.',
      type: 'fact',
      evidence: [{ kind: 'object', id: ids.OBJ_REG, version: '7', network: 'sui:mainnet' }],
    });
    await w.agent.backend.recall({ query: 'registry package deployed' });
    // clear the write-time verification so the scan has work to do
    await w.stack.db.system((tx) =>
      tx.query('update evidence set last_verified_at = null, last_result = null'),
    );
    const rep = await driftScan(w.stack.deps, { perProject: 1 });
    expect(rep).toMatchObject({ checked: 1, stale: 1 });
    expect((await row(w, dep.memoryId)).status).toBe('stale'); // the recalled deployment was checked first
    expect((await row(w, other.memoryId)).status).toBe('proposed');
    const rep2 = await driftScan(w.stack.deps, { perProject: 5 });
    expect(rep2.checked).toBe(1); // only the remaining, still-unverified memory
    expect((await row(w, other.memoryId)).status).toBe('proposed'); // version 7 is current
    const events = await w.stack.db.system((tx) =>
      tx.query<{ type: string }>(
        `select type from memory_events where memory_id = $1 and tier = 'A' order by created_at, seq`,
        [dep.memoryId],
      ),
    );
    expect(events.rows.map((e) => e.type)).toEqual(['memory.created', 'memory.stale']);
    await w.close();
  }, 120_000);

  it('does nothing without a gateway', async () => {
    const w = await world();
    expect(await driftScan(w.stack.deps)).toMatchObject({
      checked: 0,
      skippedReason: 'chain gateway not configured',
    });
    await w.close();
  }, 60_000);
});

describe('snapshot regeneration', () => {
  it('regenerates the BUIRY.md snapshot only when state changes, and writes snapshot events for confidence moves', async () => {
    const w = await world();
    const first = await snapshotRegen(w.stack.deps);
    expect(first.projectsChanged).toBe(1);
    const get = async () =>
      (
        await w.stack.db.system((tx) =>
          tx.query<{ settings: { snapshot: { hash: string; text: string } } }>(
            'select settings from projects where id = $1',
            [w.prj.id],
          ),
        )
      ).rows[0]!.settings.snapshot;
    const s1 = await get();
    expect(s1.text).toMatch(/^Generated briefing \(updated /);
    expect((await snapshotRegen(w.stack.deps)).projectsChanged).toBe(0);

    const m = await w.agent.backend.remember({
      text: 'Never import from internal/ in app code.',
      type: 'constraint',
    });
    await w.settle();
    expect((await snapshotRegen(w.stack.deps)).projectsChanged).toBe(1);
    expect((await get()).text).toContain('Never import from internal/');

    // confidence moves enough -> a durable snapshot event is queued
    await w.stack.service.resolve(admin(w.ws.id), w.prj.id, { memoryId: m.memoryId, action: 'confirm' });
    const rep = await snapshotRegen(w.stack.deps);
    expect(rep.snapshotEvents).toBe(1);
    const job = await w.stack.db.system((tx) =>
      tx.query<{ text: string }>(`select text from write_jobs where text like '%evt=memory.snapshot%'`),
    );
    expect(job.rows[0]!.text).toMatch(
      /^\[buiry\/1 evt=memory\.snapshot id=mem_\w+ branch=main agent=user-system conf=0\.80 sig=helped:0,wrong:0\]/,
    );
    expect((await snapshotRegen(w.stack.deps)).snapshotEvents).toBe(0); // unchanged since
    await w.close();
  }, 120_000);
});

describe('relayer probe', () => {
  it('records status, raises a flag while writes are paused or the relayer is down, and resolves it on recovery', async () => {
    const w = await world();
    expect(await relayerProbe(w.stack.deps, w.adapter)).toMatchObject({ state: 'ok' });
    w.c.advance(1000);
    w.mock.writeState = 'paused';
    expect((await relayerProbe(w.stack.deps, w.adapter)).state).toBe('paused');
    const open = () =>
      w.stack.db.system((tx) =>
        tx.query(`select 1 from flags where project_id = $1 and kind = 'relayer' and state <> 'resolved'`, [
          w.prj.id,
        ]),
      );
    expect((await open()).rows).toHaveLength(1);
    expect((await w.agent.backend.status()).relayer.state).toBe('paused');
    expect((await w.agent.backend.check({})).briefing).toContain('RELAYER');
    w.c.advance(1000);
    w.mock.writeState = 'ok';
    await relayerProbe(w.stack.deps, w.adapter);
    expect((await open()).rows).toHaveLength(0);
    w.c.advance(1000);
    await w.mock.close();
    expect((await relayerProbe(w.stack.deps, w.adapter)).state).toBe('unreachable');
    await w.stack.close();
  }, 120_000);
});

describe('scheduler leases', () => {
  it('runs each job once per interval across competing workers, retries failures on the next tick', async () => {
    const c = new Clock();
    const stack = await createStack({ now: c.now });
    let a = 0;
    let flaky = 0;
    const jobs = (n: { v: number }) =>
      [
        { name: 'a', intervalMs: 60_000, run: async () => ++a },
        {
          name: 'flaky',
          intervalMs: 60_000,
          run: async () => {
            if (++flaky === 1) throw new Error('boom');
            return 'ok';
          },
        },
      ].map((j) => ({ ...j, run: async () => (n.v++, j.run()) }));
    const n = { v: 0 };
    const w1 = new Scheduler(stack.deps, 'w1', jobs(n));
    const w2 = new Scheduler(stack.deps, 'w2', jobs(n));
    const [r1, r2] = [await w1.tick(), await w2.tick()];
    expect(r1.ran.map((x) => x.name)).toEqual(['a', 'flaky']);
    expect(r1.ran[1]).toMatchObject({ ok: false, error: 'boom' });
    expect(r2.ran.map((x) => x.name)).toEqual(['flaky']); // the failed run was released for retry; 'a' is not due
    expect(a).toBe(1);
    expect(flaky).toBe(2);
    c.advance(30_000);
    expect((await w1.tick()).ran).toEqual([]);
    c.advance(31_000);
    expect((await w2.tick()).ran.map((x) => x.name)).toEqual(['a', 'flaky']);
    expect(a).toBe(2);
    await stack.close();
  }, 60_000);

  it('a crashed holder frees the job when its lease expires', async () => {
    const c = new Clock();
    const stack = await createStack({ now: c.now });
    await stack.db.system((tx) =>
      tx.query(`insert into job_leases (name, holder, leased_until) values ('x','dead-worker',$1)`, [
        new Date(c.now() + 60_000),
      ]),
    );
    let ran = 0;
    const s = new Scheduler(
      stack.deps,
      'w2',
      [{ name: 'x', intervalMs: 1000, run: async () => ++ran }],
      60_000,
    );
    expect((await s.tick()).skipped).toEqual(['x']);
    c.advance(61_000);
    expect((await s.tick()).ran.map((r) => r.name)).toEqual(['x']);
    expect(ran).toBe(1);
    await stack.close();
  }, 60_000);
});

describe('isolation canary', () => {
  it('passes against the real service and leaves an audit trail only on violation', async () => {
    const c = new Clock();
    const stack = await createStack({ now: c.now, random: rand });
    // other tenants exist, so the cross-workspace RLS probe is meaningful
    const ws = await stack.newWorkspace('Other tenant');
    await stack.newProject(ws.id, 'private');
    const rep = await isolationCanary(stack.deps);
    expect(rep).toMatchObject({ ok: true, violations: [] });
    expect(rep.attempts).toBeGreaterThanOrEqual(7);
    expect((await isolationCanary(stack.deps)).ok).toBe(true); // re-runnable
    const audit = await stack.db.system((tx) =>
      tx.query(`select 1 from audit_log where action = 'canary.violation'`),
    );
    expect(audit.rows).toHaveLength(0);
    await stack.close();
  }, 120_000);
});
