import { z } from 'zod';
import { BuiryError } from '@buiry/core';
import { assertManage } from '../service/members.js';
import {
  billingSummary,
  createApiToken,
  createProjectChecked,
  listApiTokens,
  listProjects,
  revokeApiToken,
} from '../service/dashboard.js';
import {
  createWebhook,
  deleteWebhook,
  listDeliveries,
  listWebhooks,
  replayDelivery,
  testWebhook,
} from '../service/webhooks.js';
import {
  body,
  entityPrincipal,
  ok,
  parse,
  userCaller,
  workspacePrincipal,
  type Registrar,
} from './context.js';
import { genId } from '../service/util.js';
import { storagePolicy } from '../service/byo-storage.js';

export const registerWorkspace: Registrar = (_app, ctx, r) => {
  r({ method: 'PATCH', path: '/v1/workspaces/:ws', auth: 'user', scope: 'workspace' }, async (c) => {
    const p = await workspacePrincipal(ctx, await userCaller(ctx, c), c.req.param('ws')!);
    if (p.role !== 'owner' && p.role !== 'admin')
      throw new BuiryError('forbidden', 'only owners and admins rename');
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(80) }), await body(c));
    await ctx.deps.db.tenant(p.workspaceId, (tx) =>
      tx.query('update workspaces set name = $1 where id = $2', [name, p.workspaceId]),
    );
    return ok(c, { id: p.workspaceId, name });
  });
  // Whether projects here can use the deployment's shared storage (onboarding and the dashboard explain if not).
  r(
    { method: 'GET', path: '/v1/workspaces/:ws/storage-policy', auth: 'user', scope: 'workspace' },
    async (c) => {
      const p = await workspacePrincipal(ctx, await userCaller(ctx, c), c.req.param('ws')!);
      return ok(
        c,
        await ctx.deps.db.tenant(p.workspaceId, (tx) => storagePolicy(ctx.deps, tx, p.workspaceId)),
      );
    },
  );
  r({ method: 'POST', path: '/v1/workspaces', auth: 'user', scope: 'self' }, async (c) => {
    const who = await userCaller(ctx, c);
    if (who.type !== 'session') throw new BuiryError('forbidden', 'sign in to create a workspace');
    const { name } = parse(z.object({ name: z.string().min(1).max(80) }), await body(c));
    const id = genId(ctx.deps, 'wsp');
    await ctx.deps.db.system(async (tx) => {
      await tx.query('insert into workspaces (id, name) values ($1,$2)', [id, name]);
      await tx.query(`insert into memberships (workspace_id, user_id, role) values ($1,$2,'owner')`, [
        id,
        who.userId,
      ]);
    });
    return ok(c, { id, name }, 201);
  });

  r({ method: 'GET', path: '/v1/workspaces/:ws', auth: 'user', scope: 'workspace' }, async (c) => {
    const p = await workspacePrincipal(ctx, await userCaller(ctx, c), c.req.param('ws')!);
    const w = await ctx.deps.db.tenant(
      p.workspaceId,
      async (tx) =>
        (
          await tx.query<{ id: string; name: string; plan: string }>(
            'select id, name, plan from workspaces where id = $1',
            [p.workspaceId],
          )
        ).rows[0],
    );
    return ok(c, { ...w, role: p.role });
  });

  r({ method: 'GET', path: '/v1/workspaces/:ws/projects', auth: 'user', scope: 'workspace' }, async (c) => {
    const p = await workspacePrincipal(ctx, await userCaller(ctx, c), c.req.param('ws')!);
    return ok(c, await ctx.deps.db.tenant(p.workspaceId, (tx) => listProjects(tx, p)));
  });
  r({ method: 'POST', path: '/v1/workspaces/:ws/projects', auth: 'user', scope: 'workspace' }, async (c) => {
    const p = await workspacePrincipal(ctx, await userCaller(ctx, c), c.req.param('ws')!);
    const b = parse(
      z.object({
        name: z.string().min(1).max(80),
        description: z.string().max(500).optional(),
        networks: z.array(z.string()).max(8).optional(),
        walrusMode: z.enum(['managed', 'byo', 'self_hosted']).optional(),
        repoFingerprint: z.string().max(128).optional(),
      }),
      await body(c),
    );
    return ok(
      c,
      await ctx.deps.db.tenant(p.workspaceId, (tx) =>
        createProjectChecked(ctx.deps, tx, p, b, ctx.config.enforcePlans),
      ),
      201,
    );
  });

  r({ method: 'GET', path: '/v1/workspaces/:ws/billing', auth: 'user', scope: 'workspace' }, async (c) => {
    const p = await workspacePrincipal(ctx, await userCaller(ctx, c), c.req.param('ws')!);
    return ok(c, await ctx.deps.db.tenant(p.workspaceId, (tx) => billingSummary(tx, p)));
  });

  // ---- API tokens ----
  r({ method: 'GET', path: '/v1/workspaces/:ws/api-tokens', auth: 'user', scope: 'workspace' }, async (c) => {
    const p = await workspacePrincipal(ctx, await userCaller(ctx, c), c.req.param('ws')!);
    return ok(c, await ctx.deps.db.tenant(p.workspaceId, (tx) => listApiTokens(tx, p)));
  });
  r(
    { method: 'POST', path: '/v1/workspaces/:ws/api-tokens', auth: 'user', scope: 'workspace' },
    async (c) => {
      const p = await workspacePrincipal(ctx, await userCaller(ctx, c), c.req.param('ws')!);
      const b = parse(
        z.object({
          name: z.string().min(1).max(80),
          scopes: z.array(z.enum(['read', 'write', 'admin'])).min(1),
          projectIds: z.array(z.string()).optional(),
          expiresInDays: z.number().int().min(1).max(365).optional(),
        }),
        await body(c),
      );
      return ok(c, await ctx.deps.db.tenant(p.workspaceId, (tx) => createApiToken(ctx.deps, tx, p, b)), 201); // the token is shown once
    },
  );
  r({ method: 'DELETE', path: '/v1/api-tokens/:id', auth: 'user', scope: 'token' }, async (c) => {
    const { p } = await entityPrincipal(ctx, c, 'token', c.req.param('id')!);
    await ctx.deps.db.tenant(p.workspaceId, (tx) => revokeApiToken(ctx.deps, tx, p, c.req.param('id')!));
    return ok(c, { revoked: true });
  });

  // ---- webhooks ----
  r({ method: 'GET', path: '/v1/workspaces/:ws/webhooks', auth: 'user', scope: 'workspace' }, async (c) => {
    const p = await workspacePrincipal(ctx, await userCaller(ctx, c), c.req.param('ws')!);
    return ok(c, await ctx.deps.db.tenant(p.workspaceId, (tx) => listWebhooks(tx, p)));
  });
  r({ method: 'POST', path: '/v1/workspaces/:ws/webhooks', auth: 'user', scope: 'workspace' }, async (c) => {
    const p = await workspacePrincipal(ctx, await userCaller(ctx, c), c.req.param('ws')!);
    const b = parse(
      z.object({
        name: z.string().min(1).max(80),
        kind: z.enum(['slack', 'discord', 'generic']),
        url: z.string().url(),
        events: z.array(z.string()).min(1),
        projectId: z.string().optional(),
      }),
      await body(c),
    );
    return ok(
      c,
      await ctx.deps.db.tenant(p.workspaceId, (tx) => createWebhook(ctx.deps, tx, p, b, ctx.config.webhook)),
      201,
    );
  });
  r({ method: 'DELETE', path: '/v1/webhooks/:id', auth: 'user', scope: 'webhook' }, async (c) => {
    const { p } = await entityPrincipal(ctx, c, 'webhook', c.req.param('id')!);
    await ctx.deps.db.tenant(p.workspaceId, (tx) => deleteWebhook(ctx.deps, tx, p, c.req.param('id')!));
    return ok(c, { deleted: true });
  });
  r({ method: 'GET', path: '/v1/webhooks/:id/deliveries', auth: 'user', scope: 'webhook' }, async (c) => {
    const { p } = await entityPrincipal(ctx, c, 'webhook', c.req.param('id')!);
    return ok(c, await ctx.deps.db.tenant(p.workspaceId, (tx) => listDeliveries(tx, p, c.req.param('id')!)));
  });
  r({ method: 'POST', path: '/v1/webhooks/:id/test', auth: 'user', scope: 'webhook' }, async (c) => {
    const { p } = await entityPrincipal(ctx, c, 'webhook', c.req.param('id')!);
    return ok(
      c,
      await ctx.deps.db.tenant(p.workspaceId, (tx) => testWebhook(ctx.deps, tx, p, c.req.param('id')!)),
      201,
    );
  });
  r({ method: 'POST', path: '/v1/deliveries/:id/replay', auth: 'user', scope: 'delivery' }, async (c) => {
    const { p } = await entityPrincipal(ctx, c, 'delivery', c.req.param('id')!);
    return ok(
      c,
      await ctx.deps.db.tenant(p.workspaceId, (tx) => replayDelivery(ctx.deps, tx, p, c.req.param('id')!)),
      201,
    );
  });

  // ---- audit ----
  r({ method: 'GET', path: '/v1/workspaces/:ws/audit', auth: 'user', scope: 'workspace' }, async (c) => {
    const p = await workspacePrincipal(ctx, await userCaller(ctx, c), c.req.param('ws')!);
    assertManage(p);
    // audit_log is append-only and not tenant-writable; read it as the system, filtered to this workspace.
    const rows = await ctx.deps.db.system((tx) =>
      tx.query(
        'select id, actor, action, target, detail, created_at from audit_log where workspace_id = $1 order by created_at desc limit 200',
        [p.workspaceId],
      ),
    );
    return ok(c, rows.rows);
  });
};
