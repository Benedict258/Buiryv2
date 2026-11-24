import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { BuiryError, relayerHostNetwork } from '@buiry/core';
import {
  RelayerError,
  type TickReport,
  type WalrusMemoryAdapter,
  type WorkerOptions,
  type WriteWorker,
} from '@buiry/storage';
import type { Tx } from '../db/db.js';
import { assertSafeWebhookUrl, type Resolver } from './events.js';
import { assertManage } from './members.js';
import { loadProject } from './ops.js';
import { createDrain } from './sync.js';
import type { Principal, ServiceDeps } from './types.js';
import { actorOf, logActivity } from './util.js';
import { delegatePublicKey, type WalrusAccountConfig } from './walrus.js';

// ---------- sealing (AES-256-GCM, key derived from BUIRY_SECRET_KEY with its own label) ----------

const sealKey = (secretKey: string) =>
  createHash('sha256').update(`walrus-delegate-keys:${secretKey}`).digest();

export function sealDelegateKey(secretKey: string, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', sealKey(secretKey), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `enc:v1:${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${enc.toString('base64url')}`;
}

/** Opens a sealed delegate key; during a key rotation it falls back to the previous key. */
export function openDelegateKey(secretKey: string, sealed: string, previousKey?: string): string {
  try {
    return openDelegateWith(secretKey, sealed);
  } catch (e) {
    if (!previousKey) throw e;
    return openDelegateWith(previousKey, sealed);
  }
}

function openDelegateWith(secretKey: string, sealed: string): string {
  const [, , iv, tag, enc] = sealed.split(':');
  const d = createDecipheriv('aes-256-gcm', sealKey(secretKey), Buffer.from(iv!, 'base64url'));
  d.setAuthTag(Buffer.from(tag!, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(enc!, 'base64url')), d.final()]).toString('utf8');
}

// ---------- configuration ----------

export type ByoNetwork = 'mainnet' | 'testnet';

export interface ByoInput {
  relayerUrl: string;
  network: ByoNetwork;
  accountId: string;
  delegateKey: string;
}

/** What the API returns about a project's storage. Never contains the delegate key. */
export interface ProjectStorageView {
  mode: 'managed' | 'byo';
  relayerUrl?: string;
  network?: string;
  accountId?: string;
  delegatePublicKey?: string;
  updatedAt?: Date;
  /** Whether this project may use the deployment's managed account (see the managed-tenancy guard). */
  managedAllowed: boolean;
  /** The project was set up to bring its own account (onboarding choice). */
  requested?: 'byo';
  /** Memories cannot be stored until this project's own account is connected. */
  needsOwnAccount?: boolean;
  /** The deployment has no shared storage account (BUIRY_MANAGED=off, preview mode). */
  noSharedAccount?: boolean;
}

interface StorageRow {
  project_id: string;
  relayer_url: string;
  network: string;
  account_id: string;
  delegate_key_sealed: string;
  delegate_public_key: string;
  updated_at: Date;
}

/** Live probe of an account before it is saved: the relayer answers, and reports the expected network. */
export type ByoProbe = (cfg: WalrusAccountConfig) => Promise<{ network: string }>;

export interface ByoOpts {
  resolve?: Resolver;
  /** Development and tests only: allow http and private relayer addresses (BUIRY_BYO_ALLOW_PRIVATE). */
  allowPrivate?: boolean;
  probe?: ByoProbe;
}

/** Managed-account tenancy: one workspace by default, every workspace only when explicitly allowed. */
export interface ManagedTenancy {
  /** BUIRY_MANAGED_MULTI_TENANT=1: every workspace may share the managed account (A26 risk accepted). */
  multi: boolean;
  /** BUIRY_MANAGED_WORKSPACE_ID: the one workspace allowed; unset means the first workspace to write claims it. */
  workspaceId?: string;
}

const ACCOUNT_ID = /^0x[0-9a-fA-F]{1,64}$/;

async function storageRow(tx: Tx, projectId: string): Promise<StorageRow | undefined> {
  const r = await tx.query<StorageRow>(
    'select project_id, relayer_url, network, account_id, delegate_key_sealed, delegate_public_key, updated_at from project_storage where project_id = $1',
    [projectId],
  );
  return r.rows[0];
}

/** Rows still holding data in the project's current account: stored memories or writes in flight. */
async function hasData(tx: Tx, projectId: string): Promise<boolean> {
  const r = await tx.query(
    `select 1 from memories where project_id = $1 and walrus_blob_id is not null
     union all select 1 from write_jobs where project_id = $1 and state in ('queued','submitting','submitted')
     limit 1`,
    [projectId],
  );
  return r.rows.length > 0;
}

/** Agent-facing messages: they say what to do and where (the dashboard's Storage page). */
export const CONNECT_OWN_ACCOUNT =
  'this project stores memories in its own Walrus Memory account, which is not connected yet; a project admin connects it in the dashboard (project, Storage, Use your own account). Until then memories cannot be stored';
export const SHARED_ACCOUNT_TAKEN =
  "this deployment's shared Walrus account serves another workspace; a project admin connects this project's own Walrus Memory account in the dashboard (project, Storage, Use your own account). Until then memories cannot be stored";

export const NO_SHARED_ACCOUNT =
  'this deployment has no shared Walrus account, so each project stores memories in its own Walrus Memory account; a project admin connects it in the dashboard (project, Storage, Use your own account). Until then memories cannot be stored';

/** True when a storage registry is configured but holds no shared (managed) account: BUIRY_MANAGED=off (preview). */
function noSharedAccount(deps: ServiceDeps): boolean {
  return !!deps.storage && !deps.storage.managed;
}

/**
 * Writes queued for projects that have no account to store them in: no own account and no shared account on this
 * deployment (Phase 9 C1). They stay queued and are reported at startup, never deleted; connecting the project's own
 * account lets them be stored. Empty when the deployment has a shared account.
 */
export async function strandedWrites(
  deps: ServiceDeps,
  tx: Tx,
): Promise<{ projectId: string; queued: number }[]> {
  if (!noSharedAccount(deps)) return [];
  const r = await tx.query<{ project_id: string; n: string }>(
    `select w.project_id, count(*) as n from write_jobs w
      where w.state in ('queued','submitting','submitted')
        and not exists (select 1 from project_storage s where s.project_id = w.project_id)
      group by w.project_id order by w.project_id`,
  );
  return r.rows.map((x) => ({ projectId: x.project_id, queued: Number(x.n) }));
}

/** Whether new projects in a workspace can use the shared (managed) account, and if not, why. */
export async function storagePolicy(
  deps: ServiceDeps,
  tx: Tx,
  workspaceId: string,
): Promise<{ managedAvailable: boolean; reason?: string }> {
  if (deps.storage && !deps.storage.managed)
    return {
      managedAvailable: false,
      reason: 'This deployment has no shared storage account; connect your own.',
    };
  if (await managedAllowed(deps, tx, workspaceId, false)) return { managedAvailable: true };
  return {
    managedAvailable: false,
    reason:
      "This deployment's shared storage serves another workspace. Use your own Walrus Memory account for this project.",
  };
}

/**
 * Claims the shared account for a workspace when it creates its first project that uses it, so which workspace owns
 * the single-tenant shared account does not depend on who happens to write first. Does nothing if already claimed.
 */
export async function claimManagedOnCreate(deps: ServiceDeps, tx: Tx, workspaceId: string): Promise<void> {
  const t = deps.storage?.tenancy;
  if (!t || t.multi || t.workspaceId || noSharedAccount(deps)) return;
  await managedAllowed(deps, tx, workspaceId, true);
}

async function managedAllowed(
  deps: ServiceDeps,
  tx: Tx,
  workspaceId: string,
  claim: boolean,
): Promise<boolean> {
  const t = deps.storage?.tenancy;
  if (!t || t.multi) return true;
  if (t.workspaceId) return t.workspaceId === workspaceId;
  if (claim)
    await tx.query(
      'insert into managed_tenant (id, workspace_id) values (1, $1) on conflict (id) do nothing',
      [workspaceId],
    );
  const r = await tx.query<{ workspace_id: string }>('select workspace_id from managed_tenant where id = 1');
  return !r.rows[0] || r.rows[0].workspace_id === workspaceId;
}

/**
 * Called before a write is queued. Returns 'skip' for internal workspaces (the isolation canary): their events stay
 * in the database and never reach Walrus or claim the managed account. A project with its own account is always
 * allowed; otherwise the managed account must serve this workspace (one workspace unless multi-tenancy is on).
 */
export async function storageMode(
  deps: ServiceDeps,
  tx: Tx,
  workspaceId: string,
  projectId: string,
): Promise<'store' | 'skip'> {
  const plan = await tx.query<{ plan: string }>('select plan from workspaces where id = $1', [workspaceId]);
  if (plan.rows[0]?.plan === 'internal') return 'skip';
  await assertStorageAllowed(deps, tx, workspaceId, projectId);
  return 'store';
}

export async function assertStorageAllowed(
  deps: ServiceDeps,
  tx: Tx,
  workspaceId: string,
  projectId: string,
): Promise<void> {
  if (await storageRow(tx, projectId)) return;
  // A project set up to bring its own account never falls back to the shared one.
  const mode = await tx.query<{ walrus_mode: string }>('select walrus_mode from projects where id = $1', [
    projectId,
  ]);
  if (mode.rows[0]?.walrus_mode === 'byo') throw new BuiryError('forbidden', CONNECT_OWN_ACCOUNT);
  // No shared account (preview): refuse up front rather than queue a write nothing can store (Phase 9 C1).
  if (noSharedAccount(deps)) throw new BuiryError('forbidden', NO_SHARED_ACCOUNT);
  if (!deps.storage?.tenancy) return;
  if (await managedAllowed(deps, tx, workspaceId, true)) return;
  throw new BuiryError('forbidden', SHARED_ACCOUNT_TAKEN);
}

export async function getProjectStorage(
  deps: ServiceDeps,
  tx: Tx,
  p: Principal,
  projectId: string,
): Promise<ProjectStorageView> {
  await loadProject(tx, p, projectId);
  const row = await storageRow(tx, projectId);
  const allowed = !noSharedAccount(deps) && (await managedAllowed(deps, tx, p.workspaceId, false));
  const wanted = (
    await tx.query<{ walrus_mode: string }>('select walrus_mode from projects where id = $1', [projectId])
  ).rows[0]?.walrus_mode;
  if (!row)
    return {
      mode: 'managed',
      managedAllowed: allowed,
      ...(wanted === 'byo' ? { requested: 'byo' as const } : {}),
      // True when agents cannot store memories until an own account is connected.
      needsOwnAccount: wanted === 'byo' || !allowed,
      ...(noSharedAccount(deps) ? { noSharedAccount: true } : {}),
    };
  return {
    mode: 'byo',
    relayerUrl: row.relayer_url,
    network: row.network,
    accountId: row.account_id,
    delegatePublicKey: row.delegate_public_key,
    updatedAt: row.updated_at,
    managedAllowed: allowed,
  };
}

/** Validates without saving: the shape, the URL (no private addresses), the network and, if configured, a live probe. */
export async function validateByo(deps: ServiceDeps, i: ByoInput, o: ByoOpts): Promise<string> {
  // Phase 12 B: network rules first, before any lookup or probe. Mainnet needs the deployment's opt-in; a hosted
  // relayer's host must match the stated network. Other hosts (self-hosted relayers) are checked by the probe.
  if (i.network === 'mainnet' && !deps.allowMainnet)
    throw new BuiryError(
      'invalid_input',
      'this deployment does not accept mainnet accounts: mainnet needs BUIRY_ALLOW_MAINNET=1 on the server',
    );
  const hosted = relayerHostNetwork(i.relayerUrl);
  if (hosted && hosted !== i.network)
    throw new BuiryError(
      'invalid_input',
      `the relayer ${new URL(i.relayerUrl).hostname} serves ${hosted}, not ${i.network}`,
    );
  if (!ACCOUNT_ID.test(i.accountId))
    throw new BuiryError('invalid_input', 'accountId must be a 0x-prefixed Sui id');
  let publicKey: string;
  try {
    publicKey = delegatePublicKey(i.delegateKey);
  } catch (e) {
    throw new BuiryError('invalid_input', (e as Error).message);
  }
  try {
    await assertSafeWebhookUrl(i.relayerUrl, {
      ...(o.resolve ? { resolve: o.resolve } : {}),
      allowHttp: !!o.allowPrivate,
      allowPrivate: !!o.allowPrivate,
      what: 'relayer',
    });
  } catch (e) {
    throw new BuiryError('invalid_input', (e as Error).message);
  }
  const sui = deps.networks?.sui;
  if (sui && sui !== i.network)
    throw new BuiryError(
      'invalid_input',
      `this deployment runs on sui:${sui}; the account is on ${i.network}`,
    );
  if (o.probe) {
    let reported: string;
    try {
      reported = (await o.probe(i)).network;
    } catch (e) {
      if (e instanceof RelayerError && (e.kind === 'auth' || e.kind === 'client' || e.kind === 'not_found'))
        throw new BuiryError(
          'invalid_input',
          'the relayer did not accept this delegate key for this account',
        );
      throw new BuiryError(
        'storage_unavailable',
        'the relayer could not be reached or did not answer as expected',
      );
    }
    if (reported !== i.network)
      throw new BuiryError('invalid_input', `the relayer reports network ${reported}, not ${i.network}`);
  }
  return publicKey;
}

export async function setProjectStorage(
  deps: ServiceDeps,
  tx: Tx,
  p: Principal,
  projectId: string,
  i: ByoInput,
  o: ByoOpts = {},
): Promise<ProjectStorageView> {
  assertManage(p);
  await loadProject(tx, p, projectId);
  const relayerUrl = i.relayerUrl.replace(/\/+$/, '');
  const publicKey = await validateByo(deps, { ...i, relayerUrl }, o);
  const cur = await storageRow(tx, projectId);
  const sameAccount =
    cur && cur.account_id === i.accountId && cur.relayer_url === relayerUrl && cur.network === i.network;
  // A new delegate key for the same account (rotation) is always allowed. Moving a project that already has data to
  // a different account is not: its blobs stay where they were written and recall would stop finding them.
  if (!sameAccount && (await hasData(tx, projectId)))
    throw new BuiryError(
      'conflict',
      'this project already has memories in its current Walrus account; moving them to another account is not supported',
    );
  await tx.query(
    `insert into project_storage (project_id, workspace_id, relayer_url, network, account_id, delegate_key_sealed, delegate_public_key, created_by, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (project_id) do update set relayer_url = excluded.relayer_url, network = excluded.network,
       account_id = excluded.account_id, delegate_key_sealed = excluded.delegate_key_sealed,
       delegate_public_key = excluded.delegate_public_key, updated_at = excluded.updated_at`,
    [
      projectId,
      p.workspaceId,
      relayerUrl,
      i.network,
      i.accountId,
      sealDelegateKey(deps.secretKey, i.delegateKey),
      publicKey,
      p.userId,
      new Date(deps.now()),
    ],
  );
  deps.storage?.invalidate(projectId);
  await logActivity(tx, deps, {
    workspaceId: p.workspaceId,
    projectId,
    actor: actorOf(p),
    operation: cur ? (sameAccount ? 'storage.rotate_key' : 'storage.update') : 'storage.connect',
    target: { accountId: i.accountId, network: i.network, delegatePublicKey: publicKey },
    result: 'success',
  });
  return getProjectStorage(deps, tx, p, projectId);
}

export async function removeProjectStorage(
  deps: ServiceDeps,
  tx: Tx,
  p: Principal,
  projectId: string,
): Promise<ProjectStorageView> {
  assertManage(p);
  await loadProject(tx, p, projectId);
  const cur = await storageRow(tx, projectId);
  if (!cur) throw new BuiryError('not_found', 'this project uses the managed account');
  if (await hasData(tx, projectId))
    throw new BuiryError(
      'conflict',
      'this project has memories in its own Walrus account; disconnecting would leave them unreachable',
    );
  await tx.query('delete from project_storage where project_id = $1', [projectId]);
  deps.storage?.invalidate(projectId);
  await logActivity(tx, deps, {
    workspaceId: p.workspaceId,
    projectId,
    actor: actorOf(p),
    operation: 'storage.disconnect',
    target: { accountId: cur.account_id },
    result: 'success',
  });
  return getProjectStorage(deps, tx, p, projectId);
}

// ---------- adapters per account ----------

export type AdapterBuilder = (cfg: WalrusAccountConfig) => WalrusMemoryAdapter;

/**
 * Resolves the storage adapter for a project: its own account when connected, otherwise the managed one. Built
 * adapters are kept in a bounded least-recently-used cache keyed by project and configuration version, so a key
 * rotation or disconnect takes effect at once. Decrypted keys live only inside the adapters in this cache.
 */
export class StorageRegistry {
  readonly tenancy: ManagedTenancy | undefined;
  private readonly cache = new Map<string, { version: number; adapter: WalrusMemoryAdapter }>();
  private readonly max: number;

  constructor(
    private readonly o: {
      managed?: WalrusMemoryAdapter;
      build: AdapterBuilder;
      tenancy?: ManagedTenancy;
      /** Most adapters kept (default 100). */
      maxCached?: number;
    },
  ) {
    this.tenancy = o.tenancy;
    this.max = Math.max(1, o.maxCached ?? 100);
  }

  get managed(): WalrusMemoryAdapter | undefined {
    return this.o.managed;
  }

  get cachedCount(): number {
    return this.cache.size;
  }

  invalidate(projectId: string): void {
    this.cache.delete(projectId);
  }

  /** The adapter for a project's own account, or undefined when the project uses the managed account. */
  async byoAdapter(deps: ServiceDeps, projectId: string): Promise<WalrusMemoryAdapter | undefined> {
    const row = await deps.db.system((tx) => storageRow(tx, projectId));
    if (!row) {
      this.cache.delete(projectId);
      return undefined;
    }
    const version = row.updated_at.getTime();
    const hit = this.cache.get(projectId);
    if (hit && hit.version === version) {
      this.cache.delete(projectId); // refresh recency
      this.cache.set(projectId, hit);
      return hit.adapter;
    }
    const adapter = this.o.build({
      relayerUrl: row.relayer_url,
      accountId: row.account_id,
      delegateKey: openDelegateKey(deps.secretKey, row.delegate_key_sealed, deps.previousSecretKey),
    });
    this.cache.delete(projectId);
    this.cache.set(projectId, { version, adapter });
    while (this.cache.size > this.max) this.cache.delete(this.cache.keys().next().value!);
    return adapter;
  }

  async forProject(deps: ServiceDeps, projectId: string): Promise<WalrusMemoryAdapter | undefined> {
    return (await this.byoAdapter(deps, projectId)) ?? this.o.managed;
  }

  /** Every project with its own account. */
  async byoProjects(deps: ServiceDeps): Promise<string[]> {
    return deps.db.system(async (tx) =>
      (
        await tx.query<{ project_id: string }>('select project_id from project_storage order by project_id')
      ).rows.map((r) => r.project_id),
    );
  }
}

/** The adapter for a project (its own account first), or the deployment's managed adapter. */
export async function adapterForProject(
  deps: ServiceDeps,
  projectId: string,
): Promise<WalrusMemoryAdapter | undefined> {
  return deps.storage ? deps.storage.forProject(deps, projectId) : deps.adapter;
}

// ---------- one drain per account ----------

export interface AccountDrains {
  tick(): Promise<{ managed?: TickReport; byo: Record<string, TickReport | { error: string }> }>;
}

/**
 * One write worker for the managed account (every project without its own account) and one per connected project,
 * each with its own relayer health check and rate budget. Workers are rebuilt when a project's adapter changes.
 */
export function createAccountDrains(
  deps: ServiceDeps,
  registry: StorageRegistry,
  o: Partial<WorkerOptions> & { workerId?: string } = {},
): AccountDrains {
  const base = o.workerId ?? 'worker-1';
  let managed: WriteWorker | undefined;
  let connected: string[] = [];
  const byo = new Map<string, { adapter: WalrusMemoryAdapter; worker: WriteWorker }>();
  return {
    async tick() {
      const ids = await registry.byoProjects(deps);
      const out: Awaited<ReturnType<AccountDrains['tick']>> = { byo: {} };
      for (const id of [...byo.keys()]) if (!ids.includes(id)) byo.delete(id);
      for (const id of ids) {
        try {
          const adapter = await registry.byoAdapter(deps, id);
          if (!adapter) continue;
          let w = byo.get(id);
          if (!w || w.adapter !== adapter) {
            w = {
              adapter,
              worker: createDrain(deps, adapter, { ...o, workerId: `${base}:${id}`, scope: { only: [id] } }),
            };
            byo.set(id, w);
          }
          out.byo[id] = await w.worker.tick();
        } catch (e) {
          // One account failing (bad key, unreachable relayer) never stops the others. The key is never in `e`.
          out.byo[id] = { error: (e as Error).name };
        }
      }
      connected = ids;
      if (registry.managed) {
        // The scope is read at every lease, so a newly connected project leaves the managed drain at once.
        managed ??= createDrain(deps, registry.managed, {
          ...o,
          workerId: base,
          scope: () => ({ exclude: connected }),
        });
        out.managed = await managed.tick();
      }
      return out;
    },
  };
}
