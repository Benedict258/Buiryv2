#!/usr/bin/env node
import { PgDb } from '@buiry/api';

/**
 * Migration task: applies pending database migrations and exits. Run it before a deploy (on AWS, as a one-off ECS
 * task); production servers refuse to start while migrations are pending. Needs DATABASE_URL.
 */
export async function runMigrations(env: Record<string, string | undefined> = process.env): Promise<number> {
  if (!env.DATABASE_URL) {
    console.error('[buiry] DATABASE_URL is not set');
    return 2;
  }
  const db = PgDb.fromUrl(env.DATABASE_URL);
  try {
    const applied = await db.migrate();
    console.log(applied.length ? `[buiry] applied ${applied.join(', ')}` : '[buiry] database is up to date');
    return 0;
  } catch (e) {
    console.error(`[buiry] migration failed: ${(e as Error).message}`);
    return 1;
  } finally {
    await db.close();
  }
}

if (process.argv[1] && /migrate\.(ts|js)$/.test(process.argv[1]))
  void runMigrations().then((c) => process.exit(c));
