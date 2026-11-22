/**
 * Token expiry migration (Phase 8, B1). Existing API tokens created before Phase 7.4, and agent tokens issued before
 * M4, may have no expiry. This finds every active token (not revoked) with no expiry and, with --apply, gives it one
 * 90 days from now. Confirm scope is never added. Dry run by default. Prints counts and scope lists only: never a
 * token, a hash, a name or an id.
 *
 *   DATABASE_URL=... pnpm tsx scripts/real-pg/token-expiry.ts            (dry run)
 *   DATABASE_URL=... pnpm tsx scripts/real-pg/token-expiry.ts --apply    (writes, in one transaction)
 *
 * Refuses a non-local database host unless BUIRY_SEED_ALLOW_REMOTE=1 (a deployed database is remote by definition,
 * so applying it there is a deliberate step).
 */
import { PgDb, type Db, type Tx } from '@buiry/api';
import { assertLocalDatabase } from './local.js';

export const TOKEN_EXPIRY_DAYS = 90;

export interface TokenExpiryReport {
  dryRun: boolean;
  apiTokens: { activeWithoutExpiry: number; byScopes: Record<string, number>; withConfirmScope: number };
  agentTokens: { activeWithoutExpiry: number; byPermissions: Record<string, number> };
  newExpiry: string;
  updated: { apiTokens: number; agentTokens: number };
}

const tally = (rows: { k: string[] | null }[]) =>
  rows.reduce<Record<string, number>>((m, r) => {
    const key = [...(r.k ?? [])].sort().join('+') || '(none)';
    m[key] = (m[key] ?? 0) + 1;
    return m;
  }, {});

/** Plans (and with apply, performs) the expiry change inside one transaction. */
export async function tokenExpiry(db: Db, now: number, apply: boolean): Promise<TokenExpiryReport> {
  const newExpiry = new Date(now + TOKEN_EXPIRY_DAYS * 86_400_000);
  return db.system(async (tx: Tx) => {
    const api = await tx.query<{ k: string[] }>(
      'select scopes as k from api_tokens where expires_at is null and revoked_at is null',
    );
    const agent = await tx.query<{ k: string[] }>(
      `select a.permissions as k from agent_tokens t join agents a on a.id = t.agent_id
        where t.expires_at is null and t.revoked_at is null`,
    );
    const report: TokenExpiryReport = {
      dryRun: !apply,
      apiTokens: {
        activeWithoutExpiry: api.rows.length,
        byScopes: tally(api.rows),
        withConfirmScope: api.rows.filter((r) => (r.k ?? []).includes('confirm')).length,
      },
      agentTokens: { activeWithoutExpiry: agent.rows.length, byPermissions: tally(agent.rows) },
      newExpiry: newExpiry.toISOString(),
      updated: { apiTokens: 0, agentTokens: 0 },
    };
    if (apply) {
      const a = await tx.query(
        'update api_tokens set expires_at = $1 where expires_at is null and revoked_at is null returning id',
        [newExpiry],
      );
      const g = await tx.query(
        'update agent_tokens set expires_at = $1 where expires_at is null and revoked_at is null returning id',
        [newExpiry],
      );
      report.updated = { apiTokens: a.rows.length, agentTokens: g.rows.length };
    }
    return report;
  });
}

if (process.argv[1] && /token-expiry\.(ts|js)$/.test(process.argv[1])) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('set DATABASE_URL');
  assertLocalDatabase(url, process.env);
  const db = PgDb.fromUrl(url);
  try {
    console.log(JSON.stringify(await tokenExpiry(db, Date.now(), process.argv.includes('--apply')), null, 2));
    if (!process.argv.includes('--apply'))
      console.log('[token-expiry] dry run: nothing changed; --apply to write');
  } finally {
    await db.close();
  }
}
