import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { PgDb, PgliteDb, type Db } from '../src/index.js';

/**
 * The database behind test stacks (Phase 2.5). PGlite in-process by default, so the gate is unchanged. When
 * TEST_DATABASE_URL names a Postgres server (a superuser connection to an existing database, for example
 * `postgres`), every test world gets its own fresh database on that server, migrated from scratch, and dropped
 * when the world closes. The isolation suite and the migration chain can then run on real Postgres 16.
 */
/** Every database the test harness creates (and therefore may drop) starts with this. */
export const TEST_DB_PREFIX = 'buiry_test';

export type TestDbPlan =
  { kind: 'pglite' } | { kind: 'postgres'; adminUrl: string; databaseUrl: (name: string) => string };

export function testDbPlan(env: Record<string, string | undefined> = process.env): TestDbPlan {
  const url = env.TEST_DATABASE_URL?.trim();
  if (!url) return { kind: 'pglite' };
  if (!/^postgres(ql)?:\/\//.test(url)) throw new Error('TEST_DATABASE_URL must be a postgres:// URL');
  // Safety (Phase 5.1): only a throwaway server. The URL must name a database whose name starts with the test prefix
  // (a throwaway container creates it with POSTGRES_DB=buiry_test), so a URL for an existing server's usual database
  // (postgres, a product database) is refused. The host must be local unless TEST_DATABASE_ALLOW_REMOTE=1.
  // Test worlds create and drop only databases named TEST_DB_PREFIX plus random hex.
  const u = new URL(url);
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!database.startsWith(TEST_DB_PREFIX))
    throw new Error(
      `TEST_DATABASE_URL must name a database starting with "${TEST_DB_PREFIX}" (for example /buiry_test on a throwaway container); refusing "${database || '(none)'}"`,
    );
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!['localhost', '127.0.0.1', '::1'].includes(host) && env.TEST_DATABASE_ALLOW_REMOTE !== '1')
    throw new Error(
      `TEST_DATABASE_URL host "${host}" is not local; set TEST_DATABASE_ALLOW_REMOTE=1 to allow it`,
    );
  return {
    kind: 'postgres',
    adminUrl: url,
    databaseUrl: (name) => {
      const u = new URL(url);
      u.pathname = `/${name}`;
      return u.toString();
    },
  };
}

async function admin(url: string, sql: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

/** A fresh, migrated database for one test world. */
export async function freshTestDb(env: Record<string, string | undefined> = process.env): Promise<Db> {
  const plan = testDbPlan(env);
  if (plan.kind === 'pglite') return PgliteDb.create();
  const name = `${TEST_DB_PREFIX}_${randomBytes(6).toString('hex')}`; // fixed charset: safe as an identifier
  await admin(plan.adminUrl, `create database ${name}`);
  const db = PgDb.fromUrl(plan.databaseUrl(name));
  await db.migrate();
  return {
    tenant: (ws, fn) => db.tenant(ws, fn),
    system: (fn) => db.system(fn),
    close: async () => {
      await db.close();
      await admin(plan.adminUrl, `drop database if exists ${name} with (force)`);
    },
  };
}
