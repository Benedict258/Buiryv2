import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { BRIEFING_WEIGHTS, BuiryError, MEMORY_TYPES, STATUSES, type Evidence } from '@buiry/core';
import {
  activitySince,
  archiveProject,
  buiryMdFor,
  createAgentChecked,
  evidenceReport,
  exportPack,
  importPack,
  listAgents,
  listAlertRules,
  listMemories,
  listPacks,
  memoryTimeline,
  previewPack,
  projectOverview,
  queryActivity,
  retryDeadWrite,
  revokeAgentChecked,
  rotateAgentToken,
  storageHealth,
  updateProject,
  upsertAlertRule,
  verificationPanel,
  type Pack,
} from '../service/dashboard.js';
import { listFlags, listHandoffs, mergeBranchTx, replayAt, setFlagState } from '../service/collab.js';
import { loadProject } from '../service/ops.js';
import { getProjectStorage, removeProjectStorage, setProjectStorage } from '../service/byo-storage.js';
import { verifyRepoEvidence } from '../service/verification.js';
import { body, entityPrincipal, ok, parse, type Registrar } from './context.js';
import type { Context } from 'hono';

const evidenceSchema = z.custom<Evidence>((v) => typeof v === 'object' && v !== null && 'kind' in v);
const csv = (s: string | undefined) => (s ? s.split(',').filter(Boolean) : undefined);
const num = (s: string | undefined) => (s === undefined || s === '' ? undefined : Number(s));

export const registerProject: Registrar = (_app, ctx, r) => {
  const proj = (c: Context) =>
    entityPrincipal(ctx, c, 'project', c.req.param('id')!).then(({ p }) => ({ p, id: c.req.param('id')! }));
  const t = <T>(p: { workspaceId: string }, fn: Parameters<typeof ctx.deps.db.tenant<T>>[1]) =>
    ctx.deps.db.tenant(p.workspaceId, fn);

  // ---- storage account (bring your own Walrus Memory account); the delegate key is write-only ----
  r(
    { method: 'GET', path: '/v1/projects/:id/storage/account', auth: 'user', scope: 'project' },
    async (c) => {
      const { p, id } = await proj(c);
      return ok(c, await t(p, (tx) => getProjectStorage(ctx.deps, tx, p, id)));
    },
  );
  r(
    { method: 'PUT', path: '/v1/projects/:id/storage/account', auth: 'user', scope: 'project' },
    async (c) => {
      const { p, id } = await proj(c);
      const b = parse(
        z.object({
          relayerUrl: z.string().url().max(300),
          network: z.enum(['mainnet', 'testnet']),
          accountId: z.string().min(3).max(66),
          delegateKey: z.string().min(1).max(200),
        }),
        await body(c),
      );
      return ok(c, await t(p, (tx) => setProjectStorage(ctx.deps, tx, p, id, b, ctx.config.storage)));
    },
  );
  r(
    { method: 'DELETE', path: '/v1/projects/:id/storage/account', auth: 'user', scope: 'project' },
    async (c) => {
      const { p, id } = await proj(c);
      return ok(c, await t(p, (tx) => removeProjectStorage(ctx.deps, tx, p, id)));
    },
  );

  r({ method: 'GET', path: '/v1/projects/:id', auth: 'user', scope: 'project' }, async (c) => {
    const { p, id } = await proj(c);
    return ok(
      c,
      await t(p, async (tx) => {
        const pr = await loadProject(tx, p, id);
        return { ...pr, settings: { ...pr.settings, snapshot: undefined } };
      }),
    );
  });
  r({ method: 'PATCH', path: '/v1/projects/:id', auth: 'user', scope: 'project' }, async (c) => {
    const { p, id } = await proj(c);
    const b = parse(
      z.object({
        name: z.string().optional(),
        description: z.string().max(500).optional(),
        networks: z.array(z.string()).max(8).optional(),
        settings: z.record(z.string(), z.unknown()).optional(),
      }),
      await body(c),
    );
    await t(p, (tx) => updateProject(ctx.deps, tx, p, id, b));
    return ok(c, { updated: true });
  });
  r({ method: 'DELETE', path: '/v1/projects/:id', auth: 'user', scope: 'project' }, async (c) => {
    const { p, id } = await proj(c);
    if (p.role !== 'owner')
      throw new BuiryError('forbidden', 'only the workspace owner can delete a project');
    await t(p, (tx) => archiveProject(ctx.deps, tx, p, id));
    return ok(c, { archived: true });
  });
  r({ method: 'GET', path: '/v1/projects/:id/overview', auth: 'user', scope: 'project' }, async (c) => {
    const { p, id } = await proj(c);
    return ok(c, await t(p, (tx) => projectOverview(tx, p, id, ctx.deps.now())));
  });
  r({ method: 'GET', path: '/v1/projects/:id/status', auth: 'user', scope: 'project' }, async (c) => {
    const { p, id } = await proj(c);
    return ok(c, await ctx.service.status(p, id));
  });

  // ---- memories ----
  r({ method: 'GET', path: '/v1/projects/:id/memories', auth: 'user', scope: 'project' }, async (c) => {
    const { p, id } = await proj(c);
    const q = c.req.query();
    return ok(
      c,
      await t(p, (tx) =>
        listMemories(ctx.deps, tx, p, id, {
          ...(q.q ? { q: q.q } : {}),
          ...(q.type ? { type: csv(q.type) as never } : {}),
          ...(q.status ? { status: csv(q.status) as never } : {}),
          ...(q.branch ? { branch: q.branch } : {}),
          ...(q.agent ? { agent: q.agent } : {}),
          ...(num(q.minConfidence) !== undefined ? { minConfidence: num(q.minConfidence)! } : {}),
          ...(num(q.maxConfidence) !== undefined ? { maxConfidence: num(q.maxConfidence)! } : {}),
          ...(q.evidence ? { evidence: q.evidence as never } : {}),
          ...(q.expiring === 'true' ? { expiring: true } : {}),
          ...(q.flagged === 'true' ? { flagged: true } : {}),
          ...(q.createdAfter ? { createdAfter: q.createdAfter } : {}),
          ...(q.sort ? { sort: q.sort as never } : {}),
          ...(q.cursor ? { cursor: q.cursor } : {}),
          ...(num(q.limit) ? { limit: num(q.limit)! } : {}),
        }),
      ),
    );
  });
  r({ method: 'POST', path: '/v1/projects/:id/memories', auth: 'user', scope: 'project' }, async (c) => {
    const { p, id } = await proj(c);
    const b = parse(
      z.object({
        text: z.string().min(1),
        type: z.enum(MEMORY_TYPES),
        evidence: z.array(evidenceSchema).max(8).optional(),
        branch: z.string().optional(),
        relation: z
          .object({ kind: z.enum(['supersedes', 'distinct', 'agrees']), memoryId: z.string() })
          .optional(),
        idempotencyKey: z.string().max(200).optional(),
        status: z.enum(['proposed', 'confirmed']).optional(),
      }),
      await body(c),
    );
    const { status, ...input } = b;
    return ok(c, await ctx.service.remember(p, id, input, { confirmed: status === 'confirmed' }), 201);
  });
  r({ method: 'GET', path: '/v1/memories/:id', auth: 'user', scope: 'memory' }, async (c) => {
    const { p, loc } = await entityPrincipal(ctx, c, 'memory', c.req.param('id')!);
    const [detail, timeline] = await Promise.all([
      ctx.service.getMemory(p, loc.projectId!, c.req.param('id')!),
      t(p, (tx) => memoryTimeline(tx, p, loc.projectId!, c.req.param('id')!)),
    ]);
    return ok(c, { ...detail, ...timeline, untrustedData: true });
  });
  r({ method: 'GET', path: '/v1/memories/:id/events', auth: 'user', scope: 'memory' }, async (c) => {
    const { p, loc } = await entityPrincipal(ctx, c, 'memory', c.req.param('id')!);
    return ok(c, await t(p, (tx) => memoryTimeline(tx, p, loc.projectId!, c.req.param('id')!)));
  });
  for (const action of ['confirm', 'contest', 'supersede', 'tombstone'] as const) {
    r({ method: 'POST', path: `/v1/memories/:id/${action}`, auth: 'user', scope: 'memory' }, async (c) => {
      const { p, loc } = await entityPrincipal(ctx, c, 'memory', c.req.param('id')!);
      const b = parse(
        z.object({ reason: z.string().max(500).optional(), supersededBy: z.string().optional() }),
        await body(c),
      );
      return ok(
        c,
        await ctx.service.resolve(p, loc.projectId!, { memoryId: c.req.param('id')!, action, ...b }),
      );
    });
  }

  // ---- branches ----
  r({ method: 'GET', path: '/v1/projects/:id/branches', auth: 'user', scope: 'project' }, async (c) => {
    const { p, id } = await proj(c);
    return ok(c, await ctx.service.branch(p, id, { action: 'list' }));
  });
  r({ method: 'POST', path: '/v1/projects/:id/branches', auth: 'user', scope: 'project' }, async (c) => {
    const { p, id } = await proj(c);
    const b = parse(z.object({ name: z.string(), from: z.string().optional() }), await body(c));
    return ok(c, await ctx.service.branch(p, id, { action: 'create', ...b }), 201);
  });
  r(
    { method: 'GET', path: '/v1/projects/:id/branches/:slug/merge-proposal', auth: 'user', scope: 'project' },
    async (c) => {
      const { p, id } = await proj(c);
      return ok(
        c,
        await ctx.service.branch(p, id, {
          action: 'propose_merge',
          name: c.req.param('slug')!,
          ...(c.req.query('into') ? { into: c.req.query('into')! } : {}),
        }),
      );
    },
  );
  r({ method: 'POST', path: '/v1/projects/:id/merge', auth: 'user', scope: 'project' }, async (c) => {
    const { p, id } = await proj(c);
    const b = parse(
      z.object({
        source: z.string(),
        target: z.string(),
        closeSource: z.boolean().optional(),
        items: z
          .array(
            z.object({
              memoryId: z.string(),
              resolution: z
                .union([
                  z.object({ kind: z.literal('supersede'), targetMemoryId: z.string() }),
                  z.object({ kind: z.literal('distinct') }),
                  z.object({ kind: z.literal('skip') }),
                ])
                .optional(),
            }),
          )
          .min(1)
          .max(200),
      }),
      await body(c),
    );
    return ok(c, await t(p, (tx) => mergeBranchTx(ctx.deps, tx, p, id, b)), 201);
  });

  // ---- agents ----
  r({ method: 'GET', path: '/v1/projects/:id/agents', auth: 'user', scope: 'project' }, async (c) => {
    const { p, id } = await proj(c);
    return ok(c, await t(p, (tx) => listAgents(ctx.deps, tx, p, id)));
  });
  r({ method: 'POST', path: '/v1/projects/:id/agents', auth: 'user', scope: 'project' }, async (c) => {
    const { p, id } = await proj(c);
    const b = parse(
      z.object({
        name: z.string().min(1).max(60),
        tool: z.string().min(1).max(60),
        permissions: z.array(z.enum(['read', 'write', 'confirm'])).optional(),
        branchScope: z.string().optional(),
      }),
      await body(c),
    );
    return ok(c, await createAgentChecked(ctx.deps, p, id, b, ctx.config.enforcePlans), 201); // the token is shown once
  });
  r({ method: 'POST', path: '/v1/agents/:id/tokens', auth: 'user', scope: 'agent' }, async (c) => {
    const { p, loc } = await entityPrincipal(ctx, c, 'agent', c.req.param('id')!);
    return ok(c, { token: await rotateAgentToken(ctx.deps, p, loc.projectId!, c.req.param('id')!) }, 201);
  });
  r({ method: 'DELETE', path: '/v1/agents/:id', auth: 'user', scope: 'agent' }, async (c) => {
    const { p, loc } = await entityPrincipal(ctx, c, 'agent', c.req.param('id')!);
    await revokeAgentChecked(ctx.deps, p, loc.projectId!, c.req.param('id')!);
    return ok(c, { revoked: true });
  });

  // ---- flags and alerts ----
  r({ method: 'GET', path: '/v1/projects/:id/flags', auth: 'user', scope: 'project' }, async (c) => {
    const { p, id } = await proj(c);
    return ok(c, await t(p, (tx) => listFlags(tx, p, id, c.req.query('state'))));
  });
  for (const action of ['acknowledge', 'resolve'] as const) {
    r({ method: 'POST', path: `/v1/flags/:id/${action}`, auth: 'user', scope: 'flag' }, async (c) => {
      const { p, loc } = await entityPrincipal(ctx, c, 'flag', c.req.param('id')!);
      await t(p, (tx) =>
        setFlagState(
          ctx.deps,
          tx,
          p,
          loc.projectId!,
          c.req.param('id')!,
          action === 'acknowledge' ? 'acknowledged' : 'resolved',
        ),
      );
      return ok(c, { updated: true });
    });
  }
  r({ method: 'GET', path: '/v1/projects/:id/alert-rules', auth: 'user', scope: 'project' }, async (c) => {
    const { p, id } = await proj(c);
    return ok(c, await t(p, (tx) => listAlertRules(tx, p, id)));
  });
  r({ method: 'PUT', path: '/v1/projects/:id/alert-rules', auth: 'user', scope: 'project' }, async (c) => {
    const { p, id } = await proj(c);
    const b = parse(
      z.object({
        id: z.string().optional(),
        event: z.string(),
        minSeverity: z.enum(['info', 'warning', 'critical']).optional(),
        channel: z.enum(['dashboard', 'webhook']).optional(),
        webhookId: z.string().optional(),
        quietHours: z
          .object({ startHour: z.number().int().min(0).max(23), endHour: z.number().int().min(0).max(23) })
          .nullable()
          .optional(),
        grouping: z.boolean().optional(),
        enabled: z.boolean().optional(),
      }),
      await body(c),
    );
    return ok(c, await t(p, (tx) => upsertAlertRule(ctx.deps, tx, p, id, b)));
  });

  // ---- verification and storage ----
  r({ method: 'GET', path: '/v1/projects/:id/verification', auth: 'user', scope: 'project' }, async (c) => {
    const { p, id } = await proj(c);
    return ok(c, await t(p, (tx) => verificationPanel(ctx.deps, tx, p, id)));
  });
  r({ method: 'POST', path: '/v1/projects/:id/verifications', auth: 'user', scope: 'project' }, async (c) => {
    const { p, id } = await proj(c);
    const b = parse(
      z.object({ memoryId: z.string().optional(), evidence: evidenceSchema.optional() }),
      await body(c),
    );
    return ok(c, await ctx.service.verify(p, id, b as never));
  });
  r({ method: 'POST', path: '/v1/projects/:id/verify-repo', auth: 'user', scope: 'project' }, async (c) => {
    const { p, id } = await proj(c);
    const b = parse(
      z.object({
        results: z
          .record(
            z.string().max(500),
            z.object({
              exists: z.boolean(),
              changed: z.boolean(),
              currentCommit: z.string().max(64).optional(),
            }),
          )
          .refine((r) => Object.keys(r).length <= 2000, 'too many files'),
      }),
      await body(c),
    );
    return ok(c, await verifyRepoEvidence(ctx.deps, p, id, b.results));
  });
  r({ method: 'GET', path: '/v1/projects/:id/storage', auth: 'user', scope: 'project' }, async (c) => {
    const { p, id } = await proj(c);
    return ok(c, await t(p, (tx) => storageHealth(ctx.deps, tx, p, id)));
  });
  r({ method: 'POST', path: '/v1/writes/:id/retry', auth: 'user', scope: 'job' }, async (c) => {
    const { p, loc } = await entityPrincipal(ctx, c, 'job', c.req.param('id')!);
    await t(p, (tx) => retryDeadWrite(ctx.deps, tx, p, loc.projectId!, c.req.param('id')!));
    return ok(c, { requeued: true });
  });
  r(
    { method: 'GET', path: '/v1/projects/:id/evidence-report', auth: 'user', scope: 'project' },
    async (c) => {
      const { p, id } = await proj(c);
      return ok(c, await t(p, (tx) => evidenceReport(ctx.deps, tx, p, id, ctx.config.evidence)));
    },
  );

  // ---- handoffs, briefing, replay ----
  r({ method: 'GET', path: '/v1/projects/:id/handoffs', auth: 'user', scope: 'project' }, async (c) => {
    const { p, id } = await proj(c);
    return ok(
      c,
      await t(p, (tx) =>
        listHandoffs(tx, p, id, { ...(c.req.query('branch') ? { branch: c.req.query('branch')! } : {}) }),
      ),
    );
  });
  r({ method: 'POST', path: '/v1/projects/:id/handoffs', auth: 'user', scope: 'project' }, async (c) => {
    const { p, id } = await proj(c);
    const b = parse(
      z.object({
        done: z.array(z.string()),
        blocked: z.array(z.string()),
        next: z.array(z.string()),
        reliedOn: z.array(z.string()).optional(),
        notes: z.string().max(2000).optional(),
        branch: z.string().optional(),
      }),
      await body(c),
    );
    return ok(c, await ctx.service.handoff(p, id, b), 201);
  });
  r({ method: 'GET', path: '/v1/projects/:id/briefing', auth: 'user', scope: 'project' }, async (c) => {
    const { p, id } = await proj(c);
    const q = c.req.query();
    const out = await ctx.service.briefingPreview(p, id, {
      ...(q.task ? { task: q.task } : {}),
      ...(num(q.budget) ? { tokenBudget: num(q.budget)! } : {}),
      branch: q.branch ?? 'main',
      onboarding: q.onboarding === 'true',
    });
    return ok(c, { ...out, weights: BRIEFING_WEIGHTS });
  });
  r({ method: 'GET', path: '/v1/projects/:id/replay', auth: 'user', scope: 'project' }, async (c) => {
    const { p, id } = await proj(c);
    const at = c.req.query('at') ? Date.parse(c.req.query('at')!) : ctx.deps.now();
    if (Number.isNaN(at)) throw new BuiryError('invalid_input', 'at must be an ISO timestamp');
    return ok(c, await t(p, (tx) => replayAt(tx, p, id, at)));
  });
  r({ method: 'GET', path: '/v1/projects/:id/buirymd', auth: 'user', scope: 'project' }, async (c) => {
    const { p, id } = await proj(c);
    return ok(c, await t(p, (tx) => buiryMdFor(tx, p, id)));
  });

  // ---- activity ----
  r({ method: 'GET', path: '/v1/projects/:id/activity', auth: 'user', scope: 'project' }, async (c) => {
    const { p, id } = await proj(c);
    const q = c.req.query();
    return ok(
      c,
      await t(p, (tx) =>
        queryActivity(tx, p, id, {
          ...(q.cursor ? { cursor: q.cursor } : {}),
          ...(num(q.limit) ? { limit: num(q.limit)! } : {}),
          ...(q.operation ? { operation: q.operation } : {}),
          ...(q.actor ? { actor: q.actor } : {}),
          ...(q.result ? { result: q.result } : {}),
        }),
      ),
    );
  });
  r(
    { method: 'GET', path: '/v1/projects/:id/activity/stream', auth: 'user', scope: 'project' },
    async (c) => {
      const { p, id } = await proj(c);
      // Authorise before the stream opens so a refused caller gets a normal 404, not an empty stream.
      await t(p, (tx) => loadProject(tx, p, id));
      let last: string | null = c.req.header('last-event-id') ?? c.req.query('after') ?? null;
      return streamSSE(c, async (stream) => {
        let idle = 0;
        while (!stream.aborted && !stream.closed) {
          const rows = await t(p, (tx) => activitySince(tx, p, id, last));
          for (const row of rows) {
            await stream.writeSSE({ id: row.id, event: 'activity', data: JSON.stringify(row) });
            last = row.id;
          }
          if (rows.length === 0 && ++idle % 15 === 0) await stream.writeSSE({ event: 'ping', data: '{}' });
          await stream.sleep(ctx.config.feedIntervalMs);
        }
      });
    },
  );

  // ---- packs ----
  r({ method: 'GET', path: '/v1/projects/:id/packs', auth: 'user', scope: 'project' }, async (c) => {
    const { p, id } = await proj(c);
    return ok(c, await t(p, (tx) => listPacks(tx, p, id)));
  });
  r({ method: 'POST', path: '/v1/projects/:id/packs/export', auth: 'user', scope: 'project' }, async (c) => {
    const { p, id } = await proj(c);
    const b = parse(
      z.object({
        branch: z.string().optional(),
        types: z.array(z.enum(MEMORY_TYPES)).optional(),
        statuses: z.array(z.enum(STATUSES)).optional(),
        includeEvidence: z.boolean().optional(),
      }),
      await body(c),
    );
    return ok(c, await t(p, (tx) => exportPack(ctx.deps, tx, p, id, b)));
  });
  r({ method: 'POST', path: '/v1/projects/:id/packs/preview', auth: 'user', scope: 'project' }, async (c) => {
    const { p, id } = await proj(c);
    const b = parse(z.object({ pack: z.custom<Pack>() }), await body(c));
    return ok(c, await t(p, (tx) => previewPack(tx, p, id, b.pack)));
  });
  r({ method: 'POST', path: '/v1/projects/:id/packs/import', auth: 'user', scope: 'project' }, async (c) => {
    const { p, id } = await proj(c);
    const b = parse(
      z.object({
        pack: z.custom<Pack>(),
        branch: z.string().optional(),
        only: z.array(z.string()).optional(),
      }),
      await body(c),
    );
    return ok(
      c,
      await importPack(ctx.deps, p, id, b.pack, {
        ...(b.branch ? { branch: b.branch } : {}),
        ...(b.only ? { only: b.only } : {}),
      }),
      201,
    );
  });
};
