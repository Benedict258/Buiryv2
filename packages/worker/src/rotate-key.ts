#!/usr/bin/env node
import { PgDb, ResealError, resealSecrets, type Db } from '@buiry/api';

/**
 * BUIRY_SECRET_KEY rotation task (docs/KEY_CUSTODY.md, runbook). Re-encrypts every stored secret under the new key
 * in one transaction. Dry run by default; pass --apply to commit. Reads DATABASE_URL, BUIRY_SECRET_KEY_OLD and
 * BUIRY_SECRET_KEY_NEW from the environment. Prints counts and ids only, never a key or a secret.
 */
export async function rotateKey(
  argv: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  open: (url: string) => Db = (url) => PgDb.fromUrl(url),
): Promise<number> {
  const apply = argv.includes('--apply');
  const missing = ['DATABASE_URL', 'BUIRY_SECRET_KEY_OLD', 'BUIRY_SECRET_KEY_NEW'].filter((k) => !env[k]);
  if (missing.length) {
    console.error(`[buiry] rotate-key needs ${missing.join(', ')}`);
    return 2;
  }
  const db = open(env.DATABASE_URL!);
  try {
    const report = await resealSecrets(db, env.BUIRY_SECRET_KEY_OLD!, env.BUIRY_SECRET_KEY_NEW!, {
      dryRun: !apply,
    });
    console.log(JSON.stringify({ ...report, committed: apply }));
    if (!apply) console.log('[buiry] dry run: nothing was changed; run again with --apply to commit');
    return 0;
  } catch (e) {
    if (e instanceof ResealError) {
      console.error(
        JSON.stringify({ error: e.message, unreadable: e.unreadable }), // table and id only
      );
      return 1;
    }
    console.error(`[buiry] rotate-key failed: ${(e as Error).name}; nothing was committed`);
    return 1;
  } finally {
    await db.close();
  }
}

if (process.argv[1] && /rotate-key\.(ts|js)$/.test(process.argv[1]))
  void rotateKey().then((c) => process.exit(c));
