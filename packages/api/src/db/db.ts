import type { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import type { SqlClient } from '@buiry/storage';
import { MIGRATIONS, migrate } from './migrations.js';

export type Tx = SqlClient;

/**
 * Database access with two modes:
 *  - tenant(): runs as the unprivileged `buiry_app` role with `app.workspace_id` set, so row-level
 *    security is the second isolation layer under the service-level checks.
 *  - system(): owner access for token lookup, workers and system jobs. Never exposed to request input.
 */
export interface Db {
  tenant<T>(workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  system<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** In-process Postgres (WASM). Used as the "in-memory stack" for tests, conformance and the demo. */
export class PgliteDb implements Db {
  private constructor(private readonly db: PGlite) {}

  static async create(): Promise<PgliteDb> {
    // Loaded only when used: production (Postgres) never needs it, and the production image does not install it.
    const { PGlite: Lite } = await import('@electric-sql/pglite');
    const db = new Lite();
    await migrate({ query: (q, p) => db.query(q, p) as never, exec: (q) => db.exec(q) });
    return new PgliteDb(db);
  }

  private run<T>(setup: (tx: Tx) => Promise<void>, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (t) => {
      const tx: Tx = { query: (q, p) => t.query(q, p as unknown[]) as never };
      await setup(tx);
      return fn(tx);
    });
  }

  tenant<T>(workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.run(async (tx) => {
      await tx.query('set local role buiry_app');
      await tx.query(`select set_config('app.workspace_id', $1, true)`, [workspaceId]);
    }, fn);
  }

  system<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.run(async () => {}, fn);
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

/** Advisory lock key held while migrating (any constant shared by all Buiry processes). */
const MIGRATION_LOCK = 4_242_001;

/** Production Postgres via a connection pool. */
export class PgDb implements Db {
  constructor(private readonly pool: pg.Pool) {}

  static fromUrl(url: string): PgDb {
    return new PgDb(new pg.Pool({ connectionString: url }));
  }

  /**
   * Applies pending migrations while holding a Postgres advisory lock, so two runs (a migration task and a server
   * starting, or two tasks) never apply the same migration at once.
   */
  async migrate(): Promise<string[]> {
    const c = await this.pool.connect();
    try {
      await c.query('select pg_advisory_lock($1)', [MIGRATION_LOCK]);
      return await migrate({ query: (q, p) => c.query(q, p as unknown[]) as never });
    } finally {
      await c.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
      c.release();
    }
  }

  /** Migration ids not yet applied (all of them on an empty database). */
  async pending(): Promise<string[]> {
    const done = await this.pool
      .query<{ id: string }>('select id from schema_migrations')
      .then((r) => new Set(r.rows.map((x) => x.id)))
      .catch((e: { code?: string }) => {
        // Only "no such table" means an empty database; anything else (unreachable, auth) is a real error.
        if (e.code === '42P01') return new Set<string>();
        throw e;
      });
    return MIGRATIONS.map((m) => m.id).filter((id) => !done.has(id));
  }

  private async run<T>(setup: (tx: Tx) => Promise<void>, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      const tx: Tx = { query: (q, p) => c.query(q, p as unknown[]) as never };
      await setup(tx);
      const out = await fn(tx);
      await c.query('commit');
      return out;
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  tenant<T>(workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.run(async (tx) => {
      await tx.query('set local role buiry_app');
      await tx.query(`select set_config('app.workspace_id', $1, true)`, [workspaceId]);
    }, fn);
  }

  system<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.run(async () => {}, fn);
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}
