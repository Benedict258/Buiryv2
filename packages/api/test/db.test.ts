import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { migrate, MIGRATIONS } from '../src/db/migrations.js';

describe('schema + row-level security', () => {
  it('migrates, is idempotent, and isolates tenants for the app role', async () => {
    const db = new PGlite();
    const sql = {
      query: (q: string, p?: unknown[]) => db.query(q, p) as never,
      exec: (q: string) => db.exec(q),
    };
    expect(await migrate(sql)).toEqual(MIGRATIONS.map((m) => m.id));
    expect(await migrate(sql)).toEqual([]);
    await db.exec(`
      insert into workspaces (id,name) values ('wsp_a','A'),('wsp_b','B');
      insert into projects (id,workspace_id,name) values ('prj_a','wsp_a','pa'),('prj_b','wsp_b','pb');`);
    await db.exec(`set role buiry_app; select set_config('app.workspace_id','wsp_a',false);`);
    expect((await db.query<{ id: string }>('select id from projects')).rows).toEqual([{ id: 'prj_a' }]);
    await expect(
      db.exec(`insert into projects (id,workspace_id,name) values ('prj_x','wsp_b','x')`),
    ).rejects.toThrow();
    expect(
      (await db.query('update projects set name = $1 where id = $2', ['hacked', 'prj_b'])).affectedRows,
    ).toBe(0);
    // no tenant context -> nothing visible
    await db.exec(`select set_config('app.workspace_id','',false);`);
    expect((await db.query('select id from projects')).rows).toEqual([]);
    await db.exec('reset role');
  }, 60_000);
});
