import { BuiryError } from '@buiry/core';
import type { Tx } from '../db/db.js';
import type { Principal, Role, ServiceDeps, UserPrincipal } from './types.js';
import { actorOf, genId, hmac, logActivity, notFound } from './util.js';
import { randomBytes } from 'node:crypto';

const RANK: Record<Role, number> = { reader: 0, writer: 1, admin: 2, owner: 3 };

/** Admin or owner (integrations, agents, members). Agents never manage. */
export function assertManage(p: Principal): asserts p is UserPrincipal {
  if (p.kind !== 'user' || RANK[p.role] < RANK.admin)
    throw new BuiryError('forbidden', 'this needs an admin or owner');
}

export function assertOwner(p: Principal): asserts p is UserPrincipal {
  if (p.kind !== 'user' || p.role !== 'owner')
    throw new BuiryError('forbidden', 'this needs the workspace owner');
}

export async function listMembers(tx: Tx, p: Principal) {
  if (p.kind !== 'user') throw new BuiryError('forbidden', 'people only');
  const r = await tx.query<{ user_id: string; role: Role; project_scope: string[] | null; created_at: Date }>(
    'select user_id, role, project_scope, created_at from memberships order by created_at',
  );
  return r.rows;
}

export async function changeRole(deps: ServiceDeps, tx: Tx, p: Principal, userId: string, role: Role) {
  assertManage(p);
  if (role === 'owner' || (RANK[role] >= RANK[p.role] && p.role !== 'owner'))
    throw new BuiryError('forbidden', 'you cannot grant a role at or above your own');
  const cur = await tx.query<{ role: Role }>('select role from memberships where user_id = $1', [userId]);
  if (!cur.rows[0]) throw notFound('member');
  if (cur.rows[0].role === 'owner')
    throw new BuiryError('forbidden', 'the owner role cannot be changed here');
  await tx.query('update memberships set role = $1 where user_id = $2', [role, userId]);
  await logActivity(tx, deps, {
    workspaceId: p.workspaceId,
    actor: actorOf(p),
    operation: 'member.role',
    target: { userId, role },
    result: 'success',
  });
  await tx.query(
    `insert into audit_log (id, workspace_id, actor, action, target, detail) values ($1,$2,$3,'member.role',$4,$5)`,
    [genId(deps, 'evt'), p.workspaceId, p.userId, userId, JSON.stringify({ role })],
  );
}

export async function removeMember(deps: ServiceDeps, tx: Tx, p: Principal, userId: string) {
  assertManage(p);
  const cur = await tx.query<{ role: Role }>('select role from memberships where user_id = $1', [userId]);
  if (!cur.rows[0]) throw notFound('member');
  if (cur.rows[0].role === 'owner') throw new BuiryError('forbidden', 'the owner cannot be removed');
  await tx.query('delete from memberships where user_id = $1', [userId]);
  await tx.query(
    `insert into audit_log (id, workspace_id, actor, action, target) values ($1,$2,$3,'member.remove',$4)`,
    [genId(deps, 'evt'), p.workspaceId, p.userId, userId],
  );
}

export async function createInvitation(
  deps: ServiceDeps,
  tx: Tx,
  p: Principal,
  i: { invitee: string; role: Exclude<Role, 'owner'>; expiresInHours?: number },
) {
  assertManage(p);
  if (RANK[i.role] >= RANK[p.role] && p.role !== 'owner')
    throw new BuiryError('forbidden', 'you cannot invite at or above your own role');
  const token = `inv_${randomBytes(24).toString('base64url')}`;
  const id = genId(deps, 'evt');
  await tx.query(
    `insert into invitations (id, workspace_id, invitee, role, token_hash, expires_at, created_by) values ($1,$2,$3,$4,$5,$6,$7)`,
    [
      id,
      p.workspaceId,
      i.invitee,
      i.role,
      hmac(deps.secretKey, token),
      new Date(deps.now() + (i.expiresInHours ?? 168) * 3_600_000),
      p.userId,
    ],
  );
  return { id, token };
}

/** Accepting is a system operation: the invitee has no workspace context yet. */
export async function acceptInvitation(
  deps: ServiceDeps,
  token: string,
  userId: string,
): Promise<{ workspaceId: string; role: Role }> {
  return deps.db.system(async (tx) => {
    const r = await tx.query<{
      id: string;
      workspace_id: string;
      role: Role;
      expires_at: Date;
      accepted_at: Date | null;
    }>('select id, workspace_id, role, expires_at, accepted_at from invitations where token_hash = $1', [
      hmac(deps.secretKey, token),
    ]);
    const inv = r.rows[0];
    if (!inv || inv.accepted_at) throw new BuiryError('not_found', 'invitation not found or already used');
    if (new Date(inv.expires_at).getTime() < deps.now())
      throw new BuiryError('forbidden', 'this invitation has expired');
    await tx.query('update invitations set accepted_at = $1 where id = $2', [new Date(deps.now()), inv.id]);
    await tx.query(
      `insert into memberships (workspace_id, user_id, role) values ($1,$2,$3) on conflict (workspace_id, user_id) do nothing`,
      [inv.workspace_id, userId, inv.role],
    );
    return { workspaceId: inv.workspace_id, role: inv.role };
  });
}
