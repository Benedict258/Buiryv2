import { BuiryError, deriveNamespace, isValidBranchSlug, type IdPrefix } from '@buiry/core';
import type { Tx } from '../db/db.js';
import type { Permission, ServiceDeps } from './types.js';
import { genId, hmac, logActivity } from './util.js';

export const AGENT_TOKEN_PREFIX = 'bry_at_';

export async function createWorkspace(
  deps: ServiceDeps,
  name: string,
  plan = 'free',
): Promise<{ id: string }> {
  const id = genId(deps, 'wsp');
  await deps.db.system((tx) =>
    tx.query('insert into workspaces (id, name, plan) values ($1,$2,$3)', [id, name, plan]),
  );
  return { id };
}

export interface NewProject {
  workspaceId: string;
  name: string;
  description?: string;
  networks?: string[];
  walrusMode?: 'managed' | 'byo' | 'self_hosted';
  walrusAccountId?: string;
  relayerUrl?: string;
  repoFingerprint?: string;
  settings?: Record<string, unknown>;
  createdBy?: string;
}

export const DEFAULT_PROJECT_SETTINGS = {
  /** Agents may write `proposed` memories to protected `main` (merges still need an admin). */
  allowProposedOnMain: true,
  driftScanIntervalHours: 6,
  expiryMarginEpochs: 2,
};

export async function createProject(
  deps: ServiceDeps,
  p: NewProject,
): Promise<{ id: string; mainBranchId: string }> {
  const id = genId(deps, 'prj');
  const mainId = genId(deps, 'brn');
  await deps.db.tenant(p.workspaceId, async (tx) => {
    await tx.query(
      `insert into projects (id, workspace_id, name, description, networks, walrus_mode, walrus_account_id, relayer_url, repo_fingerprint, settings)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        p.workspaceId,
        p.name,
        p.description ?? null,
        p.networks ?? [],
        p.walrusMode ?? 'managed',
        p.walrusAccountId ?? null,
        p.relayerUrl ?? '',
        p.repoFingerprint ?? null,
        JSON.stringify({ ...DEFAULT_PROJECT_SETTINGS, ...(p.settings ?? {}) }),
      ],
    );
    await tx.query(
      `insert into branches (id, workspace_id, project_id, slug, namespace, protected, created_by) values ($1,$2,$3,'main',$4,true,$5)`,
      [mainId, p.workspaceId, id, deriveNamespace(id, 'main'), p.createdBy ?? null],
    );
    await logActivity(tx, deps, {
      workspaceId: p.workspaceId,
      projectId: id,
      actor: p.createdBy ? { kind: 'user', id: p.createdBy } : { kind: 'system' },
      operation: 'project.create',
      target: { projectId: id },
      result: 'success',
    });
  });
  return { id, mainBranchId: mainId };
}

export async function createBranchRow(
  deps: ServiceDeps,
  tx: Tx,
  a: {
    workspaceId: string;
    projectId: string;
    slug: string;
    parentSlug?: string;
    createdBy?: string;
    protectedBranch?: boolean;
  },
): Promise<string> {
  if (!isValidBranchSlug(a.slug)) {
    throw new BuiryError(
      'invalid_input',
      'branch names use lowercase letters, digits and single hyphens (max 63 characters)',
    );
  }
  const exists = await tx.query('select 1 from branches where project_id = $1 and slug = $2', [
    a.projectId,
    a.slug,
  ]);
  if (exists.rows.length) throw new BuiryError('conflict', `branch ${a.slug} already exists`);
  let parentId: string | null = null;
  if (a.parentSlug) {
    const p = await tx.query<{ id: string }>('select id from branches where project_id = $1 and slug = $2', [
      a.projectId,
      a.parentSlug,
    ]);
    if (!p.rows[0]) throw new BuiryError('not_found', `parent branch ${a.parentSlug} not found`);
    parentId = p.rows[0].id;
  }
  const id = genId(deps, 'brn');
  await tx.query(
    `insert into branches (id, workspace_id, project_id, slug, namespace, protected, parent_branch_id, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id,
      a.workspaceId,
      a.projectId,
      a.slug,
      deriveNamespace(a.projectId, a.slug),
      a.protectedBranch ?? false,
      parentId,
      a.createdBy ?? null,
    ],
  );
  return id;
}

export interface NewAgent {
  workspaceId: string;
  projectId: string;
  /** Short name like "claude-code"; a random suffix makes the slug unique (claude-code-7f3a). */
  name: string;
  tool: string;
  permissions?: Permission[];
  branchScope?: string;
  createdBy?: string;
}

/** Creates an agent and its first token. The plaintext token is returned once and never stored. */
export async function createAgent(
  deps: ServiceDeps,
  a: NewAgent,
): Promise<{ agentId: string; slug: string; token: string }> {
  const agentId = genId(deps, 'agt');
  const suffix = Buffer.from(deps.random(2)).toString('hex');
  const slug = `${a.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}-${suffix}`;
  await deps.db.tenant(a.workspaceId, async (tx) => {
    const proj = await tx.query('select 1 from projects where id = $1', [a.projectId]);
    if (!proj.rows.length) throw new BuiryError('not_found', 'project not found');
    await tx.query(
      `insert into agents (id, workspace_id, project_id, slug, name, tool, permissions, branch_scope) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        agentId,
        a.workspaceId,
        a.projectId,
        slug,
        a.name,
        a.tool,
        a.permissions ?? ['read', 'write'],
        a.branchScope ?? null,
      ],
    );
    await logActivity(tx, deps, {
      workspaceId: a.workspaceId,
      projectId: a.projectId,
      actor: a.createdBy ? { kind: 'user', id: a.createdBy } : { kind: 'system' },
      operation: 'agent.create',
      target: { agentId, slug },
      result: 'success',
    });
  });
  const token = await issueAgentToken(deps, a.workspaceId, agentId, a.createdBy);
  return { agentId, slug, token };
}

export async function issueAgentToken(
  deps: ServiceDeps,
  workspaceId: string,
  agentId: string,
  by?: string,
): Promise<string> {
  const token = AGENT_TOKEN_PREFIX + Buffer.from(deps.random(32)).toString('base64url');
  const id = genId(deps, 'evt' as IdPrefix);
  await deps.db.tenant(workspaceId, async (tx) => {
    const ag = await tx.query<{ project_id: string }>('select project_id from agents where id = $1', [
      agentId,
    ]);
    if (!ag.rows[0]) throw new BuiryError('not_found', 'agent not found');
    await tx.query(
      `insert into agent_tokens (id, workspace_id, agent_id, token_hash, prefix) values ($1,$2,$3,$4,$5)`,
      [id, workspaceId, agentId, hmac(deps.secretKey, token), token.slice(0, 12)],
    );
    await logActivity(tx, deps, {
      workspaceId,
      projectId: ag.rows[0].project_id,
      actor: by ? { kind: 'user', id: by } : { kind: 'system' },
      operation: 'token.issue',
      target: { agentId, tokenId: id },
      result: 'success',
    });
  });
  return token;
}

export async function revokeAgent(
  deps: ServiceDeps,
  workspaceId: string,
  agentId: string,
  by?: string,
): Promise<void> {
  await deps.db.tenant(workspaceId, async (tx) => {
    const r = await tx.query<{ project_id: string }>(
      'update agents set revoked_at = now() where id = $1 and revoked_at is null returning project_id',
      [agentId],
    );
    if (!r.rows[0]) throw new BuiryError('not_found', 'agent not found or already revoked');
    await tx.query('update agent_tokens set revoked_at = now() where agent_id = $1 and revoked_at is null', [
      agentId,
    ]);
    await logActivity(tx, deps, {
      workspaceId,
      projectId: r.rows[0].project_id,
      actor: by ? { kind: 'user', id: by } : { kind: 'system' },
      operation: 'agent.revoke',
      target: { agentId },
      result: 'success',
    });
  });
}
