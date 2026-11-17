import { describe, expect, it, vi } from 'vitest';
import { BuiryError } from '@buiry/core';
import { createStack, type Stack } from './helpers.js';
import {
  AuthService,
  authenticateAgentToken,
  createWebhook,
  hmac,
  MemoryMailer,
  openDelegateKey,
  openSecret,
  ResealError,
  resealSecrets,
  sealDelegateKey,
  sealSecret,
  type Db,
  type UserPrincipal,
} from '../src/index.js';

// Phase B: BUIRY_SECRET_KEY rotation. Stored secrets are re-sealed in one verified transaction; tokens keep working
// through the previous key and are re-hashed on first use.

const OLD = 'rotation-test-old-key-ABCDEFGHIJKLMNOPQRST';
const NEW = 'rotation-test-new-key-UVWXYZabcdefghijklmn';
const DELEGATE = '33'.repeat(32);

async function world() {
  const s = await createStack({ secretKey: OLD });
  const ws = await s.newWorkspace();
  const prj = await s.newProject(ws.id);
  const owner: UserPrincipal = {
    kind: 'user',
    workspaceId: ws.id,
    userId: 'usr_o',
    displayName: 'o',
    role: 'owner',
    projectScope: null,
  };
  const opts = { resolve: async () => ['93.184.216.34'] };
  const hooks: { id: string; secret: string }[] = [];
  for (const n of ['a', 'b'])
    hooks.push(
      await s.db.tenant(ws.id, (tx) =>
        createWebhook(
          s.deps,
          tx,
          owner,
          { name: n, kind: 'generic', url: `https://h.example/${n}`, events: ['*'] },
          opts,
        ),
      ),
    );
  // A third webhook already sealed under the new key: the database holds both key versions.
  const third = await s.db.tenant(ws.id, (tx) =>
    createWebhook(
      s.deps,
      tx,
      owner,
      { name: 'c', kind: 'generic', url: 'https://h.example/c', events: ['*'] },
      opts,
    ),
  );
  await s.db.system((tx) =>
    tx.query('update webhooks set secret = $1 where id = $2', [sealSecret(NEW, third.secret), third.id]),
  );
  hooks.push(third);
  await s.db.system((tx) =>
    tx.query(
      `insert into project_storage (project_id, workspace_id, relayer_url, network, account_id, delegate_key_sealed, delegate_public_key)
       values ($1,$2,'https://relayer.example','testnet','0xabc',$3,'pub')`,
      [prj.id, ws.id, sealDelegateKey(OLD, DELEGATE)],
    ),
  );
  return { s, ws, prj, owner, hooks };
}

const snapshot = (s: Stack) =>
  s.db.system(async (tx) => ({
    hooks: (await tx.query<{ id: string; secret: string }>('select id, secret from webhooks order by id'))
      .rows,
    keys: (await tx.query<{ v: string }>('select delegate_key_sealed as v from project_storage')).rows,
  }));

describe('BUIRY_SECRET_KEY rotation', () => {
  it('dry run reports and changes nothing; apply re-seals and verifies; a re-run is a no-op', async () => {
    const { s, hooks } = await world();
    const before = await snapshot(s);

    const dry = await resealSecrets(s.db, OLD, NEW, { dryRun: true });
    expect(dry).toMatchObject({
      dryRun: true,
      webhooks: { total: 3, resealed: 2, alreadyCurrent: 1 },
      delegateKeys: { total: 1, resealed: 1, alreadyCurrent: 0 },
      verified: 3,
    });
    expect(await snapshot(s)).toEqual(before);

    const done = await resealSecrets(s.db, OLD, NEW);
    expect(done).toMatchObject({ dryRun: false, verified: 3 });
    const after = await snapshot(s);
    for (const h of after.hooks) {
      const plain = hooks.find((x) => x.id === h.id)!.secret;
      expect(openSecret(NEW, h.secret)).toBe(plain);
      expect(() => openSecret(OLD, h.secret)).toThrow();
    }
    expect(openDelegateKey(NEW, after.keys[0]!.v)).toBe(DELEGATE);

    const again = await resealSecrets(s.db, OLD, NEW);
    expect(again.webhooks).toEqual({ total: 3, resealed: 0, alreadyCurrent: 3 });
    expect(again.delegateKeys).toEqual({ total: 1, resealed: 0, alreadyCurrent: 1 });
    await s.close();
  });

  it('changes nothing when a row opens with neither key, and reports only table and id', async () => {
    const { s, hooks } = await world();
    await s.db.system((tx) =>
      tx.query('update webhooks set secret = $1 where id = $2', [
        sealSecret('some-other-key-entirely-0123456789ab', 'x'),
        hooks[0]!.id,
      ]),
    );
    const before = await snapshot(s);
    const e = await resealSecrets(s.db, OLD, NEW).catch((x: ResealError) => x);
    expect(e).toBeInstanceOf(ResealError);
    expect((e as ResealError).unreadable).toEqual([{ table: 'webhooks', id: hooks[0]!.id }]);
    expect(await snapshot(s)).toEqual(before);
    await s.close();
  });

  it('loses nothing when the database fails halfway through the updates', async () => {
    const { s } = await world();
    const before = await snapshot(s);
    let updates = 0;
    const flaky: Db = {
      tenant: (w, fn) => s.db.tenant(w, fn),
      system: (fn) =>
        s.db.system((tx) =>
          fn({
            query: (q: string, p?: unknown[]) => {
              if (/^update /.test(q) && ++updates === 2) throw new Error('connection lost');
              return tx.query(q, p);
            },
          } as never),
        ),
      close: () => Promise.resolve(),
    };
    await expect(resealSecrets(flaky, OLD, NEW)).rejects.toThrow('connection lost');
    expect(await snapshot(s)).toEqual(before);
    await s.close();
  });

  it('keeps tokens working through the previous key and re-hashes them on first use', async () => {
    const { s, ws, prj } = await world();
    const agent = await s.newAgent({ workspaceId: ws.id, projectId: prj.id, name: 'a', tool: 'claude-code' });
    const auth = new AuthService(s.deps, {
      domain: 'x',
      baseUrl: 'https://x',
      mailer: new MemoryMailer(),
    } as never);
    const { session } = await auth.signIn('email', 'rot@example.com', { email: 'rot@example.com' });

    const rotated = { ...s.deps, secretKey: NEW, previousSecretKey: OLD };
    await expect(authenticateAgentToken(rotated, agent.token)).resolves.toMatchObject({ kind: 'agent' });
    const stored = await s.db.system(
      async (tx) => (await tx.query<{ h: string }>('select token_hash as h from agent_tokens')).rows[0]!.h,
    );
    expect(stored).toBe(hmac(NEW, agent.token));
    const rotatedAuth = new AuthService(rotated, {
      domain: 'x',
      baseUrl: 'https://x',
      mailer: new MemoryMailer(),
    } as never);
    await expect(rotatedAuth.resolveSession(session.token)).resolves.toMatchObject({
      userId: session.userId,
    });

    // After the overlap (previous key removed) the upgraded tokens still work.
    const after = { ...s.deps, secretKey: NEW };
    await expect(authenticateAgentToken(after, agent.token)).resolves.toMatchObject({ kind: 'agent' });
    await expect(
      new AuthService(after, {
        domain: 'x',
        baseUrl: 'https://x',
        mailer: new MemoryMailer(),
      } as never).resolveSession(session.token),
    ).resolves.toBeTruthy();

    // Without the previous key, a token never used during the overlap is refused.
    const other = await s.newAgent({ workspaceId: ws.id, projectId: prj.id, name: 'b', tool: 'generic' });
    const e = await authenticateAgentToken(after, other.token).catch((x: BuiryError) => x);
    expect((e as BuiryError).code).toBe('unauthorized');
    await s.close();
  });

  it('the rotate-key task prints counts only, never a key or a secret', async () => {
    const { s, hooks } = await world();
    const out: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
    const err = vi
      .spyOn(console, 'error')
      .mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
    const { rotateKey } = await import('../../worker/src/rotate-key.js');
    const env = { DATABASE_URL: 'unused', BUIRY_SECRET_KEY_OLD: OLD, BUIRY_SECRET_KEY_NEW: NEW };
    const keep: Db = {
      ...s.db,
      tenant: s.db.tenant.bind(s.db),
      system: s.db.system.bind(s.db),
      close: async () => {},
    };
    expect(await rotateKey([], env, () => keep)).toBe(0);
    expect(await rotateKey(['--apply'], env, () => keep)).toBe(0);
    log.mockRestore();
    err.mockRestore();
    const text = out.join('\n');
    expect(text).toContain('"committed":true');
    for (const secret of [OLD, NEW, DELEGATE, ...hooks.map((h) => h.secret)])
      expect(text).not.toContain(secret);
    await s.close();
  });
});
