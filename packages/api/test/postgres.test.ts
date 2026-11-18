import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, PgDb } from '../src/index.js';
import { TEST_DB_PREFIX, freshTestDb, testDbPlan } from './test-db.js';

// Phase 2.5: the test database is pluggable. PGlite by default (the gate is unchanged); real Postgres when
// TEST_DATABASE_URL is set (LOCAL_CHECKS L-PG1). The Postgres-only block is skipped without it.

describe('test database plan', () => {
  it('uses PGlite by default and a fresh database per world on the TEST_DATABASE_URL server', () => {
    expect(testDbPlan({})).toEqual({ kind: 'pglite' });
    const plan = testDbPlan({
      TEST_DATABASE_URL: 'postgres://u:pw@127.0.0.1:55432/buiry_test?sslmode=disable',
    });
    expect(plan.kind).toBe('postgres');
    if (plan.kind !== 'postgres') return;
    expect(plan.databaseUrl('buiry_test_ab12')).toBe(
      'postgres://u:pw@127.0.0.1:55432/buiry_test_ab12?sslmode=disable',
    );
    expect(() => testDbPlan({ TEST_DATABASE_URL: 'mysql://x' })).toThrow(/postgres/);
  });

  it('refuses any database that is not a throwaway test database, and remote hosts without a flag (Phase 5.1)', () => {
    // An existing server's usual databases are refused, whatever the port.
    for (const db of ['postgres', 'buiry', 'template1', ''])
      expect(() => testDbPlan({ TEST_DATABASE_URL: `postgres://u:pw@127.0.0.1:5432/${db}` }), db).toThrow(
        /must name a database starting with "buiry_test"/,
      );
    expect(() => testDbPlan({ TEST_DATABASE_URL: 'postgres://u:pw@db.example.com:5432/buiry_test' })).toThrow(
      /not local/,
    );
    const remote = {
      TEST_DATABASE_URL: 'postgres://u:pw@db.example.com:5432/buiry_test',
      TEST_DATABASE_ALLOW_REMOTE: '1',
    };
    expect(testDbPlan(remote).kind).toBe('postgres');
    expect(testDbPlan({ TEST_DATABASE_URL: 'postgres://u:pw@[::1]:55432/buiry_test' }).kind).toBe('postgres');
  });

  it('gives a migrated database by default (PGlite)', async () => {
    const db = await freshTestDb({});
    const ids = await db.system((tx) =>
      tx.query<{ id: string }>('select id from schema_migrations order by id'),
    );
    expect(ids.rows.map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id));
    await db.close();
  }, 60_000);
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('real Postgres (TEST_DATABASE_URL, L-PG1)', () => {
  it('applies the whole migration chain once and is idempotent', async () => {
    const plan = testDbPlan();
    if (plan.kind !== 'postgres') throw new Error('unreachable');
    const name = `${TEST_DB_PREFIX}_${randomBytes(6).toString('hex')}`;
    const admin = new pg.Client({ connectionString: plan.adminUrl });
    await admin.connect();
    await admin.query(`create database ${name}`);
    const db = PgDb.fromUrl(plan.databaseUrl(name));
    try {
      expect(await db.pending()).toEqual(MIGRATIONS.map((m) => m.id));
      expect(await db.migrate()).toEqual(MIGRATIONS.map((m) => m.id));
      expect(await db.migrate()).toEqual([]);
      const version = await db.system((tx) =>
        tx.query<{ v: string }>("select current_setting('server_version') as v"),
      );
      console.log(
        `[L-PG1] Postgres ${version.rows[0]!.v}: applied ${MIGRATIONS.map((m) => m.id).join(', ')}`,
      );
    } finally {
      await db.close();
      await admin.query(`drop database if exists ${name} with (force)`);
      await admin.end();
    }
  }, 120_000);

  it('enforces row-level security for the tenant role', async () => {
    const db = await freshTestDb();
    try {
      await db.system((tx) =>
        tx.query(`insert into workspaces (id, name) values ('wsp_pg_a','A'), ('wsp_pg_b','B')`),
      );
      const seen = await db.tenant('wsp_pg_a', (tx) =>
        tx.query<{ id: string }>('select id from workspaces order by id'),
      );
      expect(seen.rows.map((r) => r.id)).toEqual(['wsp_pg_a']);
    } finally {
      await db.close();
    }
  }, 120_000);
});
