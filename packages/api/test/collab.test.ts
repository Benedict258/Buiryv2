import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BuiryError } from '@buiry/core';
import {
  acceptInvitation,
  assertSafeWebhookUrl,
  changeRole,
  createInvitation,
  createWebhook,
  deleteWebhook,
  deliverDue,
  isPrivateAddress,
  listDeliveries,
  listFlags,
  listHandoffs,
  listWebhooks,
  mergeBranchTx,
  openSecret,
  replayAt,
  replayDelivery,
  setFlagState,
  signWebhook,
  testWebhook,
  verifyWebhook,
  type UserPrincipal,
} from '../src/index.js';
import { Clock, createStack, type Stack } from './helpers.js';

let stack: Stack;
const clock = new Clock();
beforeAll(async () => {
  stack = await createStack({ now: clock.now });
}, 60_000);
afterAll(async () => stack.close());

const user = (workspaceId: string, role: UserPrincipal['role'], id = `usr_${role}`): UserPrincipal => ({
  kind: 'user',
  workspaceId,
  userId: id,
  displayName: id,
  role,
  projectScope: null,
});
const err = async (p: Promise<unknown>) =>
  (await p.then(
    () => null,
    (e) => e,
  )) as BuiryError | null;

async function setup() {
  const ws = await stack.newWorkspace();
  const prj = await stack.newProject(ws.id, 'orbit-api');
  const agent = await stack.newAgent({
    workspaceId: ws.id,
    projectId: prj.id,
    name: 'claude-code',
    tool: 'claude-code',
  });
  return {
    ws,
    prj,
    agent,
    admin: user(ws.id, 'admin'),
    writer: user(ws.id, 'writer'),
    reader: user(ws.id, 'reader'),
    owner: user(ws.id, 'owner'),
  };
}

describe('roles and permissions on memory operations', () => {
  it('readers read; writers write, confirm and branch but cannot merge into protected main; admins can', async () => {
    const { ws, prj, writer, reader, admin } = await setup();
    const svc = stack.service;
    expect((await err(svc.remember(reader, prj.id, { text: 'Reader attempt.', type: 'fact' })))?.code).toBe(
      'forbidden',
    );
    const m = await svc.remember(
      writer,
      prj.id,
      { text: 'Use pnpm workspaces.', type: 'decision' },
      { confirmed: true },
    );
    expect(m.status).toBe('confirmed');
    expect(await svc.getMemory(reader, prj.id, m.memoryId)).toMatchObject({
      status: 'confirmed',
      confidence: 0.8,
    });
    await svc.branch(writer, prj.id, { action: 'create', name: 'feat-x' });
    const f = await svc.remember(
      writer,
      prj.id,
      { text: 'Feature branch decision about caching.', type: 'decision', branch: 'feat-x' },
      { confirmed: true },
    );
    const merge = (p: UserPrincipal) =>
      stack.deps.db.tenant(ws.id, (tx) =>
        mergeBranchTx(stack.deps, tx, p, prj.id, {
          source: 'feat-x',
          target: 'main',
          items: [{ memoryId: f.memoryId }],
        }),
      );
    expect((await err(merge(writer)))?.code).toBe('forbidden');
    expect((await err(merge(reader)))?.code).toBe('forbidden');
    expect((await merge(admin)).written).toHaveLength(1);
  });

  it('a user with a different workspace cannot see this project', async () => {
    const { prj } = await setup();
    const other = await setup();
    expect((await err(stack.service.getMemory(other.admin, prj.id, 'mem_x')))?.code).toBe('not_found');
  });
});

describe('branch merge', () => {
  async function branchWithMemories() {
    const s = await setup();
    const svc = stack.service;
    await svc.branch(s.writer, s.prj.id, { action: 'create', name: 'feat-auth' });
    const a = await svc.remember(
      s.writer,
      s.prj.id,
      {
        text: 'Auth uses rotating refresh tokens.',
        type: 'decision',
        branch: 'feat-auth',
        evidence: [{ kind: 'file', path: 'src/auth/refresh.ts', commit: 'a1b2c3d' }],
      },
      { confirmed: true },
    );
    const b = await svc.remember(
      s.writer,
      s.prj.id,
      { text: 'Never log token values.', type: 'constraint', branch: 'feat-auth' },
      { confirmed: true },
    );
    return { ...s, a, b };
  }
  const merge = (s: Awaited<ReturnType<typeof setup>>, input: Parameters<typeof mergeBranchTx>[4]) =>
    stack.deps.db.tenant(s.ws.id, (tx) => mergeBranchTx(stack.deps, tx, s.admin, s.prj.id, input));

  it('writes new events into the target with lineage, copies evidence, keeps trust, and is idempotent', async () => {
    const s = await branchWithMemories();
    const prop = await s.agent.backend.branch({ action: 'propose_merge', name: 'feat-auth' });
    expect(prop.proposal!.candidates.map((c) => c.memoryId).sort()).toEqual(
      [s.a.memoryId, s.b.memoryId].sort(),
    );
    const out = await merge(s, {
      source: 'feat-auth',
      target: 'main',
      items: [{ memoryId: s.a.memoryId }, { memoryId: s.b.memoryId }],
    });
    expect(out.written).toHaveLength(2);
    const row = (
      await stack.db.system((tx) =>
        tx.query<{
          branch_slug: string;
          ref_memory_id: string;
          status: string;
          confidence: number;
          text: string;
        }>('select branch_slug, ref_memory_id, status, confidence, text from memories where id = $1', [
          out.written[0]!.newId,
        ]),
      )
    ).rows[0]!;
    expect(row).toMatchObject({ branch_slug: 'main', ref_memory_id: s.a.memoryId, status: 'confirmed' });
    const ev = await stack.db.system((tx) =>
      tx.query<{ kind: string }>('select kind from evidence where memory_id = $1', [out.written[0]!.newId]),
    );
    expect(ev.rows.map((e) => e.kind)).toEqual(['file']);
    const jobs = await stack.db.system((tx) =>
      tx.query<{ text: string }>(`select text from write_jobs where memory_id = $1 or memory_id = $2`, [
        out.written[0]!.newId,
        out.mergeId,
      ]),
    );
    expect(
      jobs.rows.some(
        (j) =>
          j.text.startsWith(`[buiry/1 evt=memory.created id=${out.written[0]!.newId}`) &&
          j.text.includes(`ref=${s.a.memoryId}`),
      ),
    ).toBe(true);
    expect(jobs.rows.some((j) => j.text.includes('evt=branch.merged'))).toBe(true);
    const again = await merge(s, {
      source: 'feat-auth',
      target: 'main',
      items: [{ memoryId: s.a.memoryId }],
    });
    expect(again.written).toEqual([]);
    expect(again.skipped).toEqual([s.a.memoryId]);
    // the source branch memories are untouched; main now answers recall
    expect(
      (await s.agent.backend.recall({ query: 'refresh tokens', branch: 'main' })).results.map((r) => r.text),
    ).toContain('Auth uses rotating refresh tokens.');
  });

  it('surfaces conflicts and requires an explicit resolution; supersede replaces the target memory', async () => {
    const s = await branchWithMemories();
    const old = await stack.service.remember(
      s.admin,
      s.prj.id,
      { text: 'Auth uses rotating refresh tokens and short expiry.', type: 'decision' },
      { confirmed: true },
    );
    const e = await err(
      merge(s, { source: 'feat-auth', target: 'main', items: [{ memoryId: s.a.memoryId }] }),
    );
    expect(e?.code).toBe('conflict');
    expect(JSON.stringify(e!.details)).toContain(old.memoryId);
    const ok = await merge(s, {
      source: 'feat-auth',
      target: 'main',
      items: [
        { memoryId: s.a.memoryId, resolution: { kind: 'supersede', targetMemoryId: old.memoryId } },
        { memoryId: s.b.memoryId, resolution: { kind: 'skip' } },
      ],
    });
    expect(ok.superseded).toEqual([old.memoryId]);
    expect(ok.skipped).toEqual([s.b.memoryId]);
    expect((await stack.service.getMemory(s.admin, s.prj.id, old.memoryId)).status).toBe('superseded');
    const merged = await stack.service.getMemory(s.admin, s.prj.id, ok.written[0]!.newId);
    expect(merged.supersedes).toBe(old.memoryId);
  });

  it('rejects memories from the wrong branch and the same source and target', async () => {
    const s = await branchWithMemories();
    const onMain = await stack.service.remember(
      s.admin,
      s.prj.id,
      { text: 'Main only note.', type: 'fact' },
      { confirmed: true },
    );
    expect(
      (await err(merge(s, { source: 'feat-auth', target: 'main', items: [{ memoryId: onMain.memoryId }] })))
        ?.code,
    ).toBe('invalid_input');
    expect(
      (await err(merge(s, { source: 'main', target: 'main', items: [{ memoryId: onMain.memoryId }] })))?.code,
    ).toBe('invalid_input');
    expect((await err(merge(s, { source: 'feat-auth', target: 'main', items: [] })))?.code).toBe(
      'invalid_input',
    );
  });
});

describe('flags, handoffs and replay', () => {
  it('lists, acknowledges and resolves flags; lists handoffs', async () => {
    const s = await setup();
    const m1 = await s.agent.backend.remember({ text: 'Store sessions in the database.', type: 'decision' });
    await s.agent.backend.remember({ text: 'Store sessions in Redis.', type: 'decision' });
    await s.agent.backend.handoff({ done: ['a'], blocked: [], next: ['b'], reliedOn: [m1.memoryId] });
    const flags = await stack.deps.db.tenant(s.ws.id, (tx) => listFlags(tx, s.writer, s.prj.id));
    expect(flags.map((f) => f.kind)).toContain('possible_conflict');
    const f = flags.find((x) => x.kind === 'possible_conflict')!;
    await stack.deps.db.tenant(s.ws.id, (tx) =>
      setFlagState(stack.deps, tx, s.writer, s.prj.id, f.id, 'acknowledged'),
    );
    expect(
      (await stack.deps.db.tenant(s.ws.id, (tx) => listFlags(tx, s.writer, s.prj.id, 'acknowledged'))).map(
        (x) => x.id,
      ),
    ).toEqual([f.id]);
    expect(
      (
        await err(
          stack.deps.db.tenant(s.ws.id, (tx) =>
            setFlagState(stack.deps, tx, s.reader, s.prj.id, f.id, 'resolved'),
          ),
        )
      )?.code,
    ).toBe('forbidden');
    const hs = await stack.deps.db.tenant(s.ws.id, (tx) => listHandoffs(tx, s.reader, s.prj.id));
    expect(hs).toHaveLength(1);
    expect(hs[0]).toMatchObject({ done: ['a'], next: ['b'], relied_on: [m1.memoryId] });
  });

  it('replays project state at an earlier time, with what each agent was shown', async () => {
    const c = new Clock();
    const s2 = await createStack({ now: c.now });
    const ws = await s2.newWorkspace();
    const prj = await s2.newProject(ws.id);
    const a = await s2.newAgent({ workspaceId: ws.id, projectId: prj.id, name: 'claude-code', tool: 'x' });
    const admin = user(ws.id, 'admin');
    const m = await a.backend.remember({ text: 'Registry deployed at version 3.', type: 'deployment' });
    c.advance(60_000);
    await a.backend.check({ task: 'deploy' });
    const t1 = c.now();
    c.advance(60_000);
    await s2.service.resolve(admin, prj.id, {
      memberId: undefined,
      memoryId: m.memoryId,
      action: 'confirm',
    } as never);
    c.advance(60_000);
    await s2.service.resolve(admin, prj.id, {
      memoryId: m.memoryId,
      action: 'tombstone',
      reason: 'obsolete',
    });
    const then = await s2.deps.db.tenant(ws.id, (tx) => replayAt(tx, admin, prj.id, t1));
    expect(then.counts).toEqual({ total: 1, byStatus: { proposed: 1 } });
    expect(then.memories[0]).toMatchObject({ id: m.memoryId, status: 'proposed', changedSince: true });
    expect(then.briefingsShown[0]!.memories).toEqual([{ id: m.memoryId, statusThen: 'proposed' }]);
    expect(then.events.map((e) => e.type)).toEqual(['memory.created']);
    const now = await s2.deps.db.tenant(ws.id, (tx) => replayAt(tx, admin, prj.id, c.now()));
    expect(now.counts.byStatus).toEqual({ tombstoned: 1 });
    expect(now.events.map((e) => e.type)).toEqual([
      'memory.tombstoned',
      'memory.confirmed',
      'memory.created',
    ]);
    await s2.close();
  }, 60_000);
});

describe('webhooks', () => {
  const resolve = async (h: string) =>
    h === 'hooks.example.com' ? ['93.184.216.34'] : h === 'evil.example.com' ? ['10.0.0.5'] : [];

  it('rejects unsafe urls (SSRF) and unknown events', async () => {
    for (const u of [
      'http://hooks.example.com/x',
      'https://localhost/x',
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'https://evil.example.com/x',
      'https://169.254.169.254/latest',
      'https://user:pw@hooks.example.com/x',
      'https://nxdomain.example.com/x',
      'ftp://hooks.example.com',
    ]) {
      expect((await err(assertSafeWebhookUrl(u, { resolve })))?.code, u).toBe('invalid_input');
    }
    await expect(assertSafeWebhookUrl('https://hooks.example.com/x', { resolve })).resolves.toBeUndefined();
    expect(
      ['10.1.2.3', '172.20.0.1', '192.168.1.1', '127.0.0.1', '::1', 'fd00::1', '100.64.0.1', '0.0.0.0'].every(
        isPrivateAddress,
      ),
    ).toBe(true);
    expect(['8.8.8.8', '93.184.216.34', '2606:4700::1111'].some(isPrivateAddress)).toBe(false);
    const s = await setup();
    expect(
      (
        await err(
          stack.deps.db.tenant(s.ws.id, (tx) =>
            createWebhook(
              stack.deps,
              tx,
              s.admin,
              { name: 'x', kind: 'generic', url: 'https://hooks.example.com/x', events: ['nope'] },
              { resolve },
            ),
          ),
        )
      )?.code,
    ).toBe('invalid_input');
    expect(
      (
        await err(
          stack.deps.db.tenant(s.ws.id, (tx) =>
            createWebhook(
              stack.deps,
              tx,
              s.writer,
              { name: 'x', kind: 'generic', url: 'https://hooks.example.com/x', events: ['memory.stale'] },
              { resolve },
            ),
          ),
        )
      )?.code,
    ).toBe('forbidden');
  });

  it('signs with HMAC-SHA256 over the timestamp and body; receivers can verify and reject replays', () => {
    const header = signWebhook('whsec_test', 1_800_000_000, '{"a":1}');
    expect(header).toMatch(/^t=1800000000,v1=[0-9a-f]{64}$/);
    expect(verifyWebhook('whsec_test', header, '{"a":1}', 1_800_000_010)).toBe(true);
    expect(verifyWebhook('whsec_test', header, '{"a":2}', 1_800_000_010)).toBe(false);
    expect(verifyWebhook('other', header, '{"a":1}', 1_800_000_010)).toBe(false);
    expect(verifyWebhook('whsec_test', header, '{"a":1}', 1_800_001_000)).toBe(false);
    expect(verifyWebhook('whsec_test', 'garbage', '{"a":1}', 1_800_000_010)).toBe(false);
  });

  it('delivers stale and flag events with a verifiable signature, stores the secret sealed, and logs deliveries', async () => {
    const s = await setup();
    const hook = await stack.deps.db.tenant(s.ws.id, (tx) =>
      createWebhook(
        stack.deps,
        tx,
        s.admin,
        {
          name: 'ops',
          kind: 'generic',
          url: 'https://hooks.example.com/buiry',
          events: ['memory.stale', 'flag.created'],
          projectId: s.prj.id,
        },
        { resolve },
      ),
    );
    expect(hook.secret).toMatch(/^whsec_/);
    const stored = (
      await stack.db.system((tx) =>
        tx.query<{ secret: string }>('select secret from webhooks where id = $1', [hook.id]),
      )
    ).rows[0]!.secret;
    expect(stored).not.toContain(hook.secret);
    expect(openSecret(stack.deps.secretKey, stored)).toBe(hook.secret);

    const m = await s.agent.backend.remember({ text: 'Package pinned.', type: 'deployment' });
    const sh = await stack.service.resolve(s.admin, s.prj.id, {
      memoryId: m.memoryId,
      action: 'contest',
      reason: 'looks wrong',
    });
    void sh;
    // make the memory stale through the learning loop
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    await stack.db.system((tx) =>
      tx.query(`update memories set status = 'confirmed' where id = $1`, [m.memoryId]),
    );
    await stack.service
      .verify(s.admin, s.prj.id, { evidence: { kind: 'file', path: 'x', commit: 'y' } })
      .catch(() => {});
    await stack.deps.db.tenant(s.ws.id, async (tx) => {
      const { raiseFlag } = await import('../src/index.js');
      await raiseFlag(stack.deps, tx, {
        workspaceId: s.ws.id,
        projectId: s.prj.id,
        memoryId: m.memoryId,
        kind: 'stale',
        severity: 'critical',
        detail: 'package upgraded',
      });
    });
    const rep = await deliverDue(stack.deps, { fetch: f, resolve });
    expect(rep.delivered).toBeGreaterThanOrEqual(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://hooks.example.com/buiry');
    expect(call.headers['buiry-event']).toBe('flag.created');
    const ts = Number(/t=(\d+)/.exec(call.headers['buiry-signature']!)![1]);
    expect(verifyWebhook(hook.secret, call.headers['buiry-signature']!, call.body, ts)).toBe(true);
    expect(JSON.parse(call.body)).toMatchObject({
      type: 'flag.created',
      project: s.prj.id,
      severity: 'critical',
      data: { kind: 'stale', memoryId: m.memoryId },
    });
    const log = await stack.deps.db.tenant(s.ws.id, (tx) => listDeliveries(tx, s.admin, hook.id));
    expect(log.some((d) => d.state === 'delivered' && d.status_code === 200)).toBe(true);
    const test = await stack.deps.db.tenant(s.ws.id, (tx) => testWebhook(stack.deps, tx, s.admin, hook.id));
    const rep2 = await deliverDue(stack.deps, { fetch: f, resolve });
    expect(rep2.delivered).toBe(1);
    expect(calls.at(-1)!.headers['buiry-event']).toBe('test');
    await stack.deps.db.tenant(s.ws.id, (tx) => replayDelivery(stack.deps, tx, s.admin, test.id));
    expect((await deliverDue(stack.deps, { fetch: f, resolve })).delivered).toBe(1);
    expect(await stack.deps.db.tenant(s.ws.id, (tx) => listWebhooks(tx, s.admin))).toHaveLength(1);
    await stack.deps.db.tenant(s.ws.id, (tx) => deleteWebhook(stack.deps, tx, s.admin, hook.id));
  });

  it('formats Slack and Discord payloads', async () => {
    const s = await setup();
    const seen: unknown[] = [];
    const f = (async (_u: string, init: RequestInit) => {
      seen.push(JSON.parse(String(init.body)));
      return new Response('ok');
    }) as unknown as typeof fetch;
    for (const kind of ['slack', 'discord'] as const) {
      await stack.deps.db.tenant(s.ws.id, (tx) =>
        createWebhook(
          stack.deps,
          tx,
          s.admin,
          {
            name: kind,
            kind,
            url: `https://hooks.example.com/${kind}`,
            events: ['memory.created'],
            projectId: s.prj.id,
          },
          { resolve },
        ),
      );
    }
    await s.agent.backend.remember({ text: 'Notify the channel about this decision.', type: 'decision' });
    await deliverDue(stack.deps, { fetch: f, resolve });
    expect(seen).toHaveLength(2);
    expect(
      seen.some(
        (b) =>
          typeof (b as { text?: string }).text === 'string' &&
          (b as { text: string }).text.startsWith('[Buiry] memory.created'),
      ),
    ).toBe(true);
    expect(seen.some((b) => typeof (b as { content?: string }).content === 'string')).toBe(true);
  });

  it('retries with backoff, dead-letters after the attempt limit, and pauses a failing endpoint', async () => {
    const c = new Clock();
    const s2 = await createStack({ now: c.now });
    const ws = await s2.newWorkspace();
    const prj = await s2.newProject(ws.id);
    const a = await s2.newAgent({
      workspaceId: ws.id,
      projectId: prj.id,
      name: 'x',
      tool: 'x',
      permissions: ['read', 'write'],
    });
    const admin = user(ws.id, 'admin');
    const hook = await s2.deps.db.tenant(ws.id, (tx) =>
      createWebhook(
        s2.deps,
        tx,
        admin,
        {
          name: 'flaky',
          kind: 'generic',
          url: 'https://hooks.example.com/x',
          events: ['memory.created'],
          projectId: prj.id,
        },
        { resolve },
      ),
    );
    for (let i = 0; i < 6; i++)
      await a.backend.remember({
        text: `Unique note number ${i} about ${'abcdefghij'[i]} topics.`,
        type: 'fact',
      });
    let n = 0;
    const down = (async () => {
      n++;
      return new Response('bad gateway', { status: 502 });
    }) as unknown as typeof fetch;
    const r1 = await deliverDue(s2.deps, { fetch: down, resolve, maxAttempts: 2, pauseAfter: 5 });
    expect(r1.retried + r1.failed).toBeGreaterThan(0);
    expect(r1.paused).toEqual([hook.id]);
    const st = (
      await s2.db.system((tx) =>
        tx.query<{ status: string; paused_reason: string }>(
          'select status, paused_reason from webhooks where id = $1',
          [hook.id],
        ),
      )
    ).rows[0]!;
    expect(st.status).toBe('paused');
    expect(st.paused_reason).toMatch(/consecutive failures/);
    const before = n;
    expect((await deliverDue(s2.deps, { fetch: down, resolve })).delivered).toBe(0);
    expect(n).toBe(before); // a paused endpoint is not called
    const audit = await s2.db.system((tx) =>
      tx.query(`select 1 from audit_log where action = 'webhook.paused'`),
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    await s2.close();
  }, 60_000);

  it('does not deliver to a webhook of another workspace', async () => {
    const a = await setup();
    const b = await setup();
    await stack.deps.db.tenant(b.ws.id, (tx) =>
      createWebhook(
        stack.deps,
        tx,
        b.admin,
        { name: 'b', kind: 'generic', url: 'https://hooks.example.com/b', events: ['memory.created'] },
        { resolve },
      ),
    );
    const seen: string[] = [];
    await a.agent.backend.remember({ text: 'Only workspace A should see this.', type: 'fact' });
    const f = (async (_u: string, init: RequestInit) => (
      seen.push(String(init.body)),
      new Response('ok')
    )) as unknown as typeof fetch;
    await deliverDue(stack.deps, { fetch: f, resolve });
    expect(seen.filter((b2) => b2.includes('Only workspace A'))).toEqual([]);
  });
});

describe('members and invitations', () => {
  it('invites, accepts once, enforces role ceilings, and records audit entries', async () => {
    const s = await setup();
    const inv = await stack.deps.db.tenant(s.ws.id, (tx) =>
      createInvitation(stack.deps, tx, s.admin, { invitee: 'sam@example.com', role: 'writer' }),
    );
    expect(
      (
        await err(
          stack.deps.db.tenant(s.ws.id, (tx) =>
            createInvitation(stack.deps, tx, s.admin, { invitee: 'x@example.com', role: 'admin' }),
          ),
        )
      )?.code,
    ).toBe('forbidden');
    expect(
      (
        await err(
          stack.deps.db.tenant(s.ws.id, (tx) =>
            createInvitation(stack.deps, tx, s.writer, { invitee: 'x@example.com', role: 'reader' }),
          ),
        )
      )?.code,
    ).toBe('forbidden');
    await stack.db.system((tx) =>
      tx.query(`insert into users (id, email) values ('usr_sam','sam@example.com')`),
    );
    expect(await acceptInvitation(stack.deps, inv.token, 'usr_sam')).toEqual({
      workspaceId: s.ws.id,
      role: 'writer',
    });
    expect((await err(acceptInvitation(stack.deps, inv.token, 'usr_sam')))?.code).toBe('not_found');
    expect((await err(acceptInvitation(stack.deps, 'inv_bogus', 'usr_sam')))?.code).toBe('not_found');
    await stack.db.system((tx) =>
      tx.query(`insert into users (id, email) values ('usr_owner','owner@example.com')`),
    );
    await stack.db.system((tx) =>
      tx.query(`insert into memberships (workspace_id, user_id, role) values ($1,'usr_owner','owner')`, [
        s.ws.id,
      ]),
    );
    await stack.deps.db.tenant(s.ws.id, (tx) => changeRole(stack.deps, tx, s.owner, 'usr_sam', 'reader'));
    expect(
      (
        await err(
          stack.deps.db.tenant(s.ws.id, (tx) => changeRole(stack.deps, tx, s.admin, 'usr_owner', 'reader')),
        )
      )?.code,
    ).toBe('forbidden');
    const audit = await stack.db.system((tx) =>
      tx.query(`select 1 from audit_log where workspace_id = $1 and action = 'member.role'`, [s.ws.id]),
    );
    expect(audit.rows).toHaveLength(1);
    const expired = await stack.deps.db.tenant(s.ws.id, (tx) =>
      createInvitation(stack.deps, tx, s.admin, {
        invitee: 'late@example.com',
        role: 'reader',
        expiresInHours: 1,
      }),
    );
    clock.advance(2 * 3_600_000);
    expect((await err(acceptInvitation(stack.deps, expired.token, 'usr_sam')))?.code).toBe('forbidden');
  });
});
