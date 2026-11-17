import { describe, expect, it } from 'vitest';
import { BuiryError } from '@buiry/core';
import { Clock, createStack } from './helpers.js';
import { listAgents, rotateAgentToken, type UserPrincipal } from '../src/index.js';

// SECURITY_REVIEW M4: agent tokens expire after a configured lifetime, the dashboard shows the expiry and a rotation
// reminder, and rotation revokes the old token at once (no overlap).

describe('agent token lifetime', () => {
  it('expires tokens, reminds before expiry, and rotation revokes the old token immediately', async () => {
    const c = new Clock();
    const s = await createStack({ now: c.now, agentTokenMaxDays: 1 });
    const ws = await s.newWorkspace();
    const prj = await s.newProject(ws.id);
    const owner: UserPrincipal = {
      kind: 'user',
      workspaceId: ws.id,
      userId: 'usr_owner',
      displayName: 'owner',
      role: 'owner',
      projectScope: null,
    };
    const a = await s.newAgent({
      workspaceId: ws.id,
      projectId: prj.id,
      name: 'claude',
      tool: 'claude-code',
    });
    await expect((await s.backendFor(a.token)).check({ task: 'x' })).resolves.toBeTruthy();

    const listed = await s.db.tenant(ws.id, (tx) => listAgents(s.deps, tx, owner, prj.id));
    expect(new Date(listed[0]!.tokenExpiresAt!).getTime()).toBe(c.now() + 86_400_000);
    expect(listed[0]!.tokenExpiresSoon).toBe(true);

    c.advance(2 * 86_400_000);
    const expired = await s.backendFor(a.token).catch((e: BuiryError) => e);
    expect((expired as BuiryError).code).toBe('unauthorized');
    expect((expired as BuiryError).message).toContain('expired');

    const fresh = await rotateAgentToken(s.deps, owner, prj.id, a.agentId);
    await expect((await s.backendFor(fresh)).check({ task: 'x' })).resolves.toBeTruthy();
    const old = await s.backendFor(a.token).catch((e: BuiryError) => e);
    expect((old as BuiryError).message).toContain('revoked');
    await s.close();
  });

  it('issues tokens without expiry when no lifetime is configured', async () => {
    const s = await createStack({});
    const ws = await s.newWorkspace();
    const prj = await s.newProject(ws.id);
    await s.newAgent({ workspaceId: ws.id, projectId: prj.id, name: 'a', tool: 'generic' });
    const r = await s.db.system((tx) =>
      tx.query<{ expires_at: Date | null }>('select expires_at from agent_tokens'),
    );
    expect(r.rows.every((x) => x.expires_at === null)).toBe(true);
    await s.close();
  });
});
