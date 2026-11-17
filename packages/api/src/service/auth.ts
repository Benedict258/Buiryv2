import { BuiryError } from '@buiry/core';
import type { AgentPrincipal, Permission, ServiceDeps } from './types.js';
import { genId, hmac, logActivity } from './util.js';

/**
 * Resolves an agent token to a principal. Only a keyed hash is stored; revoked tokens and revoked
 * agents are rejected and the rejection is logged (FR-G3).
 */
export async function authenticateAgentToken(
  deps: ServiceDeps,
  token: string,
  sessionId?: string,
): Promise<AgentPrincipal> {
  if (!token.startsWith('bry_at_')) throw new BuiryError('unauthorized', 'invalid agent token');
  const hash = hmac(deps.secretKey, token);
  const row = await deps.db.system(async (tx) => {
    const r = await tx.query<{
      token_id: string;
      token_revoked: Date | null;
      token_expires: Date | null;
      last_used_at: Date | null;
      agent_id: string;
      slug: string;
      tool: string;
      workspace_id: string;
      project_id: string;
      permissions: Permission[];
      branch_scope: string | null;
      agent_revoked: Date | null;
    }>(
      `select t.id as token_id, t.revoked_at as token_revoked, t.expires_at as token_expires, t.last_used_at, a.id as agent_id, a.slug, a.tool, a.workspace_id, a.project_id,
              a.permissions, a.branch_scope, a.revoked_at as agent_revoked
         from agent_tokens t join agents a on a.id = t.agent_id where t.token_hash = $1`,
      [hash],
    );
    const x = r.rows[0];
    if (!x) return null;
    if (x.token_revoked || x.agent_revoked) {
      await logActivity(tx, deps, {
        workspaceId: x.workspace_id,
        projectId: x.project_id,
        actor: { kind: 'agent', id: x.slug },
        operation: 'auth.rejected',
        target: { agentId: x.agent_id, tokenId: x.token_id },
        result: 'error',
        detail: { reason: 'revoked' },
      });
      return { revoked: true as const };
    }
    if (x.token_expires && new Date(x.token_expires).getTime() <= deps.now()) {
      await logActivity(tx, deps, {
        workspaceId: x.workspace_id,
        projectId: x.project_id,
        actor: { kind: 'agent', id: x.slug },
        operation: 'auth.rejected',
        target: { agentId: x.agent_id, tokenId: x.token_id },
        result: 'error',
        detail: { reason: 'expired' },
      });
      return { expired: true as const };
    }
    const last = x.last_used_at ? new Date(x.last_used_at).getTime() : 0;
    if (deps.now() - last > 60_000)
      await tx.query('update agent_tokens set last_used_at = $1 where id = $2', [
        new Date(deps.now()),
        x.token_id,
      ]);
    return x;
  });
  if (!row) throw new BuiryError('unauthorized', 'invalid agent token');
  if ('revoked' in row) throw new BuiryError('unauthorized', 'this agent token has been revoked');
  if ('expired' in row)
    throw new BuiryError(
      'unauthorized',
      'this agent token has expired; rotate it in the dashboard (Agents) or run `buiry connect` again',
    );
  return {
    kind: 'agent',
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    agentId: row.agent_id,
    agentSlug: row.slug,
    tool: row.tool,
    permissions: row.permissions,
    branchScope: row.branch_scope,
    sessionId: sessionId ?? genId(deps, 'evt'),
  };
}
