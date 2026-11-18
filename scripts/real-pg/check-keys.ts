/**
 * After a BUIRY_SECRET_KEY rotation (LOCAL_CHECKS L-KEY1): checks that every sealed secret opens with the new key
 * and that none opens with the old key alone. Prints counts only.
 *
 *   DATABASE_URL=... BUIRY_SECRET_KEY_OLD=<old> BUIRY_SECRET_KEY_NEW=<new> pnpm tsx scripts/real-pg/check-keys.ts
 */
import { PgDb, openDelegateKey, openSecret } from '@buiry/api';
import { assertLocalDatabase } from './local.js';

const { DATABASE_URL: url, BUIRY_SECRET_KEY_OLD: oldKey, BUIRY_SECRET_KEY_NEW: newKey } = process.env;
if (!url || !oldKey || !newKey)
  throw new Error('set DATABASE_URL, BUIRY_SECRET_KEY_OLD and BUIRY_SECRET_KEY_NEW');
assertLocalDatabase(url, process.env);

const opens = (f: () => string) => {
  try {
    f();
    return true;
  } catch {
    return false;
  }
};
const db = PgDb.fromUrl(url);
try {
  const hooks = await db.system((tx) => tx.query<{ secret: string }>('select secret from webhooks'));
  const own = await db.system((tx) =>
    tx.query<{ delegate_key_sealed: string }>('select delegate_key_sealed from project_storage'),
  );
  const report = {
    webhooks: hooks.rows.length,
    webhooksOpenWithNew: hooks.rows.filter((r) => opens(() => openSecret(newKey, r.secret))).length,
    webhooksOpenWithOldOnly: hooks.rows.filter((r) => opens(() => openSecret(oldKey, r.secret))).length,
    ownAccounts: own.rows.length,
    ownAccountsOpenWithNew: own.rows.filter((r) =>
      opens(() => openDelegateKey(newKey, r.delegate_key_sealed)),
    ).length,
    ownAccountsOpenWithOldOnly: own.rows.filter((r) =>
      opens(() => openDelegateKey(oldKey, r.delegate_key_sealed)),
    ).length,
  };
  console.log(JSON.stringify(report));
  const ok =
    report.webhooksOpenWithNew === report.webhooks &&
    report.ownAccountsOpenWithNew === report.ownAccounts &&
    report.webhooksOpenWithOldOnly === 0 &&
    report.ownAccountsOpenWithOldOnly === 0 &&
    report.webhooks + report.ownAccounts > 0;
  console.log(ok ? '[check-keys] PASS' : '[check-keys] FAIL');
  process.exitCode = ok ? 0 : 1;
} finally {
  await db.close();
}
