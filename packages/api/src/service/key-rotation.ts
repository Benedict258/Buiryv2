import type { Db, Tx } from '../db/db.js';
import { openDelegateKey, sealDelegateKey } from './byo-storage.js';
import { openSecret, sealSecret } from './webhooks.js';

/**
 * BUIRY_SECRET_KEY rotation: re-encrypts every stored secret sealed with the key (webhook signing secrets and the
 * per-project Walrus delegate keys) under a new key.
 *
 * - One transaction with the rows locked: either every secret is re-sealed and verified, or nothing changes.
 * - Rows already sealed under the new key are left alone, so a re-run (or a database with both key versions) is
 *   safe.
 * - Before committing, every re-sealed value is decrypted with the new key and compared; any mismatch rolls back.
 * - A row that opens with neither key aborts the run (nothing is written) and is reported by table and id only.
 * - Plaintext is held in memory only for the re-seal; the report contains counts and ids, never values.
 *
 * Token hashes (sessions, agent tokens, API tokens, links, invitations) are HMACs and cannot be re-encrypted: they
 * keep working through BUIRY_SECRET_KEY_PREVIOUS and are re-hashed on first use (see the runbook).
 */

export interface ResealCounts {
  total: number;
  resealed: number;
  alreadyCurrent: number;
}

export interface ResealReport {
  dryRun: boolean;
  webhooks: ResealCounts;
  delegateKeys: ResealCounts;
  /** Values decrypted with the new key after re-sealing (inside the transaction). */
  verified: number;
}

export class ResealError extends Error {
  constructor(
    message: string,
    readonly unreadable: { table: string; id: string }[] = [],
  ) {
    super(message);
    this.name = 'ResealError';
  }
}

interface Target {
  table: 'webhooks' | 'project_storage';
  idCol: string;
  valCol: string;
  open: (key: string, sealed: string) => string;
  seal: (key: string, plain: string) => string;
}

const TARGETS: Target[] = [
  { table: 'webhooks', idCol: 'id', valCol: 'secret', open: openSecret, seal: sealSecret },
  {
    table: 'project_storage',
    idCol: 'project_id',
    valCol: 'delegate_key_sealed',
    open: openDelegateKey,
    seal: sealDelegateKey,
  },
];

const tryOpen = (t: Target, key: string, sealed: string): string | null => {
  try {
    return t.open(key, sealed);
  } catch {
    return null;
  }
};

class DryRunRollback extends Error {
  constructor(readonly report: ResealReport) {
    super('dry run');
  }
}

async function resealIn(tx: Tx, oldKey: string, newKey: string, dryRun: boolean): Promise<ResealReport> {
  const report: ResealReport = {
    dryRun,
    webhooks: { total: 0, resealed: 0, alreadyCurrent: 0 },
    delegateKeys: { total: 0, resealed: 0, alreadyCurrent: 0 },
    verified: 0,
  };
  const unreadable: { table: string; id: string }[] = [];
  const planned: { t: Target; id: string; plain: string; sealed: string }[] = [];
  for (const t of TARGETS) {
    const counts = t.table === 'webhooks' ? report.webhooks : report.delegateKeys;
    const rows = await tx.query<{ id: string; val: string }>(
      `select ${t.idCol} as id, ${t.valCol} as val from ${t.table} order by ${t.idCol} for update`,
    );
    for (const r of rows.rows) {
      counts.total++;
      if (tryOpen(t, newKey, r.val) !== null) {
        counts.alreadyCurrent++;
        continue;
      }
      const plain = tryOpen(t, oldKey, r.val);
      if (plain === null) {
        unreadable.push({ table: t.table, id: r.id });
        continue;
      }
      planned.push({ t, id: r.id, plain, sealed: t.seal(newKey, plain) });
      counts.resealed++;
    }
  }
  if (unreadable.length)
    throw new ResealError(
      `${unreadable.length} stored secret(s) open with neither key; nothing was changed`,
      unreadable,
    );
  for (const p of planned)
    await tx.query(`update ${p.t.table} set ${p.t.valCol} = $1 where ${p.t.idCol} = $2`, [p.sealed, p.id]);
  // Verify inside the transaction: every planned value must now open with the new key to the same plaintext.
  for (const p of planned) {
    const back = await tx.query<{ val: string }>(
      `select ${p.t.valCol} as val from ${p.t.table} where ${p.t.idCol} = $1`,
      [p.id],
    );
    if (tryOpen(p.t, newKey, back.rows[0]?.val ?? '') !== p.plain)
      throw new ResealError(`verification failed for ${p.t.table} ${p.id}; nothing was changed`);
    report.verified++;
  }
  if (dryRun) throw new DryRunRollback(report);
  return report;
}

export async function resealSecrets(
  db: Db,
  oldKey: string,
  newKey: string,
  o: { dryRun?: boolean } = {},
): Promise<ResealReport> {
  if (oldKey.length < 32 || newKey.length < 32)
    throw new ResealError('both keys must be at least 32 characters');
  if (oldKey === newKey) throw new ResealError('the new key is the same as the old key');
  try {
    return await db.system((tx) => resealIn(tx, oldKey, newKey, o.dryRun ?? false));
  } catch (e) {
    // A dry run does all the work, including verification, then rolls back.
    if (e instanceof DryRunRollback) return e.report;
    throw e;
  }
}
