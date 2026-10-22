/** Live check against a real Postgres (LOCAL_CHECKS L-A3). */
import { PgDb } from '../packages/api/src/index.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('set DATABASE_URL');
const db = PgDb.fromUrl(url);
console.log('applied:', await db.migrate());
await db.system((tx) =>
  tx.query(
    `insert into workspaces (id, name) values ('wsp_smoke_a','A'), ('wsp_smoke_b','B') on conflict do nothing`,
  ),
);
const seen = await db.tenant('wsp_smoke_a', async (tx) =>
  (await tx.query<{ id: string }>('select id from workspaces')).rows.map((r) => r.id),
);
if (seen.length !== 1 || seen[0] !== 'wsp_smoke_a')
  throw new Error(`row-level security failed: saw ${JSON.stringify(seen)}`);
await db.system((tx) => tx.query(`delete from workspaces where id in ('wsp_smoke_a','wsp_smoke_b')`));
await db.close();
console.log('OK');
