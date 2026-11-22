import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStack, type Stack } from '@buiry/api';
import { tokenExpiry } from './token-expiry.js';

// Phase 8 B1: the token expiry migration. Dry run changes nothing; apply gives active tokens without an expiry one
// 90 days out, never touches revoked or already-expiring tokens, never adds the confirm scope, and the report holds
// no token, hash, name or id.

const NOW = Date.parse('2026-11-21T12:00:00Z');
let s: Stack;
beforeAll(async () => {
  s = await createStack({ now: () => NOW });
  const ws = await s.newWorkspace('Tokens');
  const prj = await s.newProject(ws.id, 'tokens');
  await s.newAgent({ workspaceId: ws.id, projectId: prj.id, name: 'old', tool: 'claude-code' }); // token, no expiry
  const ins = (id: string, scopes: string[], expires: Date | null, revoked: Date | null) =>
    s.db.system((tx) =>
      tx.query(
        `insert into api_tokens (id, workspace_id, name, token_hash, prefix, scopes, expires_at, revoked_at)
         values ($1, $2, $3, $4, 'bry_pat_xxxx', $5, $6, $7)`,
        [id, ws.id, `name-${id}`, `hash-${id}`, scopes, expires, revoked],
      ),
    );
  await ins('tok_a', ['read'], null, null);
  await ins('tok_b', ['read', 'write'], null, null);
  await ins('tok_c', ['read', 'write'], new Date(NOW + 10 * 86_400_000), null); // already expires
  await ins('tok_d', ['admin'], null, new Date(NOW - 1000)); // revoked
  await s.db.system((tx) => tx.query('update agent_tokens set expires_at = null'));
}, 60_000);
afterAll(() => s.close());

const rows = () =>
  s.db.system((tx) =>
    tx.query<{ id: string; scopes: string[]; expires_at: Date | null }>(
      'select id, scopes, expires_at from api_tokens order by id',
    ),
  );

describe('token expiry migration', () => {
  it('dry run counts active tokens without an expiry and changes nothing', async () => {
    const before = (await rows()).rows;
    const r = await tokenExpiry(s.db, NOW, false);
    expect(r).toMatchObject({
      dryRun: true,
      apiTokens: { activeWithoutExpiry: 2, byScopes: { read: 1, 'read+write': 1 }, withConfirmScope: 0 },
      agentTokens: { activeWithoutExpiry: 1, byPermissions: { 'read+write': 1 } },
      updated: { apiTokens: 0, agentTokens: 0 },
    });
    expect((await rows()).rows).toEqual(before);
    const text = JSON.stringify(r);
    for (const secret of ['hash-', 'name-', 'tok_', 'bry_pat_']) expect(text).not.toContain(secret);
  });

  it('apply sets a 90-day expiry on exactly those tokens and never adds the confirm scope', async () => {
    const r = await tokenExpiry(s.db, NOW, true);
    expect(r.updated).toEqual({ apiTokens: 2, agentTokens: 1 });
    const after = Object.fromEntries((await rows()).rows.map((x) => [x.id, x]));
    const in90 = NOW + 90 * 86_400_000;
    expect(new Date(after.tok_a!.expires_at!).getTime()).toBe(in90);
    expect(new Date(after.tok_b!.expires_at!).getTime()).toBe(in90);
    expect(new Date(after.tok_c!.expires_at!).getTime()).toBe(NOW + 10 * 86_400_000); // unchanged
    expect(after.tok_d!.expires_at).toBeNull(); // revoked: left alone
    for (const x of Object.values(after)) expect(x.scopes).not.toContain('confirm');
    expect((await tokenExpiry(s.db, NOW, false)).apiTokens.activeWithoutExpiry).toBe(0);
  });
});
