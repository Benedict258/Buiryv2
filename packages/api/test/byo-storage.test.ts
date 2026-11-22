import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BuiryError } from '@buiry/core';
import { Ed25519Signer, HttpWalrusAdapter, MockRelayer, RelayerError } from '@buiry/storage';
import { Clock, createStack, type Stack } from './helpers.js';
import {
  checkRuntimeNetworks,
  createAccountDrains,
  getProjectStorage,
  openDelegateKey,
  removeProjectStorage,
  setProjectStorage,
  StorageRegistry,
  type ByoOpts,
  type UserPrincipal,
} from '../src/index.js';

// Phase 5: a project can bring its own Walrus Memory account. Its writes, recall and drain stay in that account; the
// delegate key is sealed at rest and never returned or logged; the managed account serves a single workspace.

const KEY_A = '33'.repeat(32);
const KEY_B = '11'.repeat(32);
const MANAGED_KEY = '44'.repeat(32);

const clock = new Clock();
let managedRelayer: MockRelayer;
let ownRelayer: MockRelayer;
let registry: StorageRegistry;
let built: string[];
let s: Stack;
const logged: string[] = [];

const user = (workspaceId: string, role: UserPrincipal['role'] = 'admin'): UserPrincipal => ({
  kind: 'user',
  workspaceId,
  userId: `usr_${role}_${workspaceId}`,
  displayName: role,
  role,
  projectScope: null,
});
const opts: ByoOpts = { allowPrivate: true, probe: async () => ({ network: 'testnet' }) };
const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => (e instanceof BuiryError ? e.code : `other: ${(e as Error).message}`),
  );
const adapterFor = (url: string, accountId: string, key: string) =>
  new HttpWalrusAdapter({ baseUrl: url, accountId, signer: new Ed25519Signer(key), now: clock.now });
const connect = (ws: string, project: string, accountId = '0xb10', key = KEY_A, o: ByoOpts = opts) =>
  s.db.tenant(ws, (tx) =>
    setProjectStorage(
      s.deps,
      tx,
      user(ws),
      project,
      { relayerUrl: ownRelayer.url, network: 'testnet', accountId, delegateKey: key },
      o,
    ),
  );

beforeAll(async () => {
  managedRelayer = await MockRelayer.start({ now: clock.now, autoCompleteMs: 0 });
  ownRelayer = await MockRelayer.start({ now: clock.now, autoCompleteMs: 0 });
  built = [];
  registry = new StorageRegistry({
    managed: adapterFor(managedRelayer.url, '0xacc0', MANAGED_KEY),
    build: (cfg) => {
      built.push(cfg.accountId);
      return adapterFor(cfg.relayerUrl, cfg.accountId, cfg.delegateKey);
    },
    tenancy: { multi: false },
    maxCached: 2,
  });
  s = await createStack({ now: clock.now, adapter: registry.managed!, storage: registry });
  for (const k of ['log', 'warn', 'error', 'info', 'debug'] as const)
    vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')));
}, 60_000);
afterAll(async () => {
  vi.restoreAllMocks();
  await s.close();
  await managedRelayer.close();
  await ownRelayer.close();
});

describe('bring-your-own Walrus account', () => {
  it("keeps a project's writes, recall and drain in its own account, and other projects in the managed one", async () => {
    const ws = await s.newWorkspace('Own Account Co');
    const own = await s.newProject(ws.id, 'own-account');
    const shared = await s.newProject(ws.id, 'managed-account');
    const view = await connect(ws.id, own.id);
    expect(view).toMatchObject({ mode: 'byo', accountId: '0xb10', network: 'testnet' });
    const a = await s.newAgent({ workspaceId: ws.id, projectId: own.id, name: 'a', tool: 'claude-code' });
    const b = await s.newAgent({ workspaceId: ws.id, projectId: shared.id, name: 'b', tool: 'claude-code' });
    await a.backend.remember({ text: 'Own-account decision: use the blue relayer.', type: 'decision' });
    await b.backend.remember({ text: 'Managed decision: use the green relayer.', type: 'decision' });

    const drains = createAccountDrains(s.deps, registry, { pollIntervalMs: 0 });
    for (let i = 0; i < 4; i++) {
      await drains.tick();
      clock.advance(3000);
    }
    expect(ownRelayer.blobs).toHaveLength(1);
    expect(ownRelayer.blobs[0]!.text).toContain('Own-account decision: use the blue relayer.');
    expect(managedRelayer.blobs.some((x) => x.text.includes('blue relayer'))).toBe(false);
    expect(ownRelayer.blobs.every((x) => x.namespace.includes(own.id))).toBe(true);
    expect(managedRelayer.blobs.some((x) => x.namespace.includes(own.id))).toBe(false);
    expect(managedRelayer.blobs.some((x) => x.namespace.includes(shared.id))).toBe(true);

    const recalled = await a.backend.recall({ query: 'which relayer' });
    const texts = JSON.stringify(recalled);
    expect(texts).toContain('blue relayer');
    expect(texts).not.toContain('green relayer');
  });

  it('seals the delegate key at rest and never returns or logs it', async () => {
    const ws = await s.newWorkspace('Sealed Key Co');
    const prj = await s.newProject(ws.id, 'sealed');
    const view = await connect(ws.id, prj.id);
    const shown = JSON.stringify(view);
    expect(shown).not.toContain(KEY_A);
    expect(view.delegatePublicKey).toBe(new Ed25519Signer(KEY_A).publicKeyHex);
    const row = await s.db.system(
      async (tx) =>
        (
          await tx.query<{ delegate_key_sealed: string }>(
            'select delegate_key_sealed from project_storage where project_id = $1',
            [prj.id],
          )
        ).rows[0]!,
    );
    expect(row.delegate_key_sealed).not.toContain(KEY_A);
    expect(openDelegateKey(s.deps.secretKey, row.delegate_key_sealed)).toBe(KEY_A);
    const activity = await s.db.system(async (tx) =>
      JSON.stringify((await tx.query('select * from activity_log where project_id = $1', [prj.id])).rows),
    );
    expect(activity).toContain('storage.connect');
    expect(activity).not.toContain(KEY_A);
    await createAccountDrains(s.deps, registry).tick();
    expect(logged.join('\n')).not.toContain(KEY_A);
    expect(logged.join('\n')).not.toContain(KEY_B);
  });

  it("does not let another workspace or a non-admin read or change a project's account", async () => {
    const ws = await s.newWorkspace('Owner Co');
    const prj = await s.newProject(ws.id, 'guarded');
    await connect(ws.id, prj.id);
    const other = await s.newWorkspace('Intruder Co');
    expect(
      await code(s.db.tenant(other.id, (tx) => getProjectStorage(s.deps, tx, user(other.id), prj.id))),
    ).toBe('not_found');
    expect(await code(connect(other.id, prj.id, '0xbad'))).toBe('not_found');
    expect(
      await code(
        s.db.tenant(ws.id, (tx) =>
          setProjectStorage(
            s.deps,
            tx,
            user(ws.id, 'writer'),
            prj.id,
            { relayerUrl: ownRelayer.url, network: 'testnet', accountId: '0xb10', delegateKey: KEY_B },
            opts,
          ),
        ),
      ),
    ).toBe('forbidden');
    // Row-level security hides the row itself from another tenant.
    const seen = await s.db.tenant(other.id, (tx) =>
      tx.query('select 1 from project_storage where project_id = $1', [prj.id]),
    );
    expect(seen.rows).toHaveLength(0);
  });

  it('refuses private relayers, wrong networks, bad keys and a relayer that rejects the key', async () => {
    const ws = await s.newWorkspace('Validation Co');
    const prj = await s.newProject(ws.id, 'checks');
    expect(await code(connect(ws.id, prj.id, '0xb10', KEY_A, { probe: opts.probe! }))).toBe('invalid_input');
    const bad = await connect(ws.id, prj.id, '0xb10', 'not-a-key-zz').catch((e: Error) => e);
    expect((bad as BuiryError).code).toBe('invalid_input');
    expect((bad as Error).message).not.toContain('not-a-key-zz');
    expect(await code(connect(ws.id, prj.id, 'acct'))).toBe('invalid_input');
    const rejecting: ByoOpts = {
      allowPrivate: true,
      probe: async () => {
        throw new RelayerError('auth', 'signature rejected', 401);
      },
    };
    const r = await connect(ws.id, prj.id, '0xb10', KEY_A, rejecting).catch((e: Error) => e);
    expect((r as Error).message).toContain('did not accept this delegate key');
    const wrongNet: ByoOpts = { allowPrivate: true, probe: async () => ({ network: 'mainnet' }) };
    expect(await code(connect(ws.id, prj.id, '0xb10', KEY_A, wrongNet))).toBe('invalid_input');
    s.deps.networks = { sui: 'mainnet' };
    try {
      expect(await code(connect(ws.id, prj.id))).toBe('invalid_input');
    } finally {
      delete s.deps.networks;
    }
  });

  it('rotates the key in place, refuses moving a project with data, and keeps the adapter cache bounded', async () => {
    const ws = await s.newWorkspace('Rotation Co');
    const prj = await s.newProject(ws.id, 'rotating');
    await connect(ws.id, prj.id, '0xa0');
    const agent = await s.newAgent({ workspaceId: ws.id, projectId: prj.id, name: 'r', tool: 'claude-code' });
    await agent.backend.remember({ text: 'Rotation fact one.', type: 'fact' });
    const first = await registry.byoAdapter(s.deps, prj.id);
    clock.advance(1000);
    // Same account, new delegate key: allowed, and the next resolve builds a new adapter with it.
    const rotated = await connect(ws.id, prj.id, '0xa0', KEY_B);
    expect(rotated.delegatePublicKey).toBe(new Ed25519Signer(KEY_B).publicKeyHex);
    const second = await registry.byoAdapter(s.deps, prj.id);
    expect(second).not.toBe(first);
    // A different account while data is queued or stored: refused, and so is disconnecting.
    expect(await code(connect(ws.id, prj.id, '0xe1', KEY_B))).toBe('conflict');
    expect(
      await code(s.db.tenant(ws.id, (tx) => removeProjectStorage(s.deps, tx, user(ws.id), prj.id))),
    ).toBe('conflict');

    const extra = [];
    for (let i = 0; i < 3; i++) {
      const p = await s.newProject(ws.id, `cache-${i}`);
      await connect(ws.id, p.id, `0xc${i}`);
      extra.push(p.id);
    }
    for (const id of extra) await registry.byoAdapter(s.deps, id);
    expect(registry.cachedCount).toBeLessThanOrEqual(2);
  });

  it('disconnects a project without data, returning it to the managed account', async () => {
    const ws = await s.newWorkspace('Disconnect Co');
    const prj = await s.newProject(ws.id, 'leaving');
    await connect(ws.id, prj.id);
    const v = await s.db.tenant(ws.id, (tx) => removeProjectStorage(s.deps, tx, user(ws.id), prj.id));
    expect(v.mode).toBe('managed');
    expect(await registry.byoAdapter(s.deps, prj.id)).toBeUndefined();
  });
});

describe('managed account tenancy', () => {
  it('serves a single workspace unless multi-tenancy is enabled; own accounts are always allowed', async () => {
    // Earlier tests in this file already claimed the managed account for the first workspace that wrote to it.
    const ws = await s.newWorkspace('Second Tenant Co');
    const prj = await s.newProject(ws.id, 'second');
    const a = await s.newAgent({ workspaceId: ws.id, projectId: prj.id, name: 's', tool: 'claude-code' });
    expect(
      await code(a.backend.remember({ text: 'Should not reach the managed account.', type: 'fact' })),
    ).toBe('forbidden');
    const view = await s.db.tenant(ws.id, (tx) => getProjectStorage(s.deps, tx, user(ws.id), prj.id));
    expect(view.managedAllowed).toBe(false);
    await connect(ws.id, prj.id, '0x5ec');
    expect(await code(a.backend.remember({ text: 'Goes to its own account.', type: 'fact' }))).toBe('ok');

    const multi = new StorageRegistry({
      managed: registry.managed!,
      build: (cfg) => adapterFor(cfg.relayerUrl, cfg.accountId, cfg.delegateKey),
      tenancy: { multi: true },
    });
    const saved = s.deps.storage;
    s.deps.storage = multi;
    try {
      const p2 = await s.newProject(ws.id, 'second-managed');
      const b = await s.newAgent({ workspaceId: ws.id, projectId: p2.id, name: 't', tool: 'claude-code' });
      expect(await code(b.backend.remember({ text: 'Multi-tenant managed write.', type: 'fact' }))).toBe(
        'ok',
      );
    } finally {
      s.deps.storage = saved!;
    }
  });

  it("includes each project's own account network in the startup network check", async () => {
    const r = await checkRuntimeNetworks({
      env: { WALRUS_NETWORK: 'mainnet' },
      db: s.db,
      gatewayConfigured: false,
    });
    expect(r.mismatches.join(' ')).toContain('own Walrus account');
  });
});

describe('A11: relayer /config read failure text (Phase 8 B3)', () => {
  it('warns by error class and code, never the exception message', async () => {
    const lines: string[] = [];
    await checkRuntimeNetworks({
      env: {},
      db: s.db,
      gatewayConfigured: false,
      relayerConfig: () =>
        Promise.reject(
          Object.assign(new Error('connect ECONNREFUSED 10.9.8.7:443 relayer.internal'), {
            code: 'ECONNREFUSED',
          }),
        ),
      warn: (l: string) => void lines.push(l),
    });
    expect(lines).toEqual([
      '[buiry] could not read the relayer\'s /config, so its network was not checked: {"error":"Error","code":"ECONNREFUSED"}',
    ]);
  });
});

describe('A11: the relayer warning keeps the network code but never upstream text (Phase 9 A1)', () => {
  const adapterAt = (baseUrl: string) =>
    new HttpWalrusAdapter({ baseUrl, accountId: '0xacct', signer: new Ed25519Signer('44'.repeat(32)) });
  const warnFor = async (adapter: HttpWalrusAdapter) => {
    const lines: string[] = [];
    await checkRuntimeNetworks({
      env: {},
      db: s.db,
      gatewayConfigured: false,
      relayerConfig: () => adapter.relayerConfig(),
      warn: (l: string) => void lines.push(l),
    });
    return lines;
  };

  it('a relayer error response body (URL, token, secret) never reaches the warning; the kind and status do', async () => {
    const { createServer } = await import('node:http');
    const body = JSON.stringify({
      error:
        'upstream failed at https://relayer.internal/v1/config?token=SECRET-TOKEN-123 key=suiprivkey1secret',
      message: 'Bearer SECRET-BEARER',
    });
    const server = createServer((_req, res) =>
      res.writeHead(400, { 'content-type': 'application/json' }).end(body),
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const lines = await warnFor(adapterAt(`http://127.0.0.1:${port}`));
      expect(lines).toHaveLength(1);
      for (const leak of ['relayer.internal', 'SECRET', 'suiprivkey', 'Bearer', 'https://', 'upstream'])
        expect(lines[0], leak).not.toContain(leak);
      expect(lines[0]).toContain('"kind":"client"');
      expect(lines[0]).toContain('"status":400');
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  }, 60_000);

  it('a network failure shows its cause code', async () => {
    // A port that was just free and is now closed (port 1 is on fetch's blocked list and never reaches the network).
    const { createServer } = await import('node:http');
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as { port: number }).port;
    await new Promise((r) => probe.close(r));
    const lines = await warnFor(adapterAt(`http://127.0.0.1:${port}`));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/"cause":"(ECONNREFUSED|UND_ERR_[A-Z_]+)"/);
    expect(lines[0]).not.toContain('127.0.0.1');
  }, 60_000);
});
