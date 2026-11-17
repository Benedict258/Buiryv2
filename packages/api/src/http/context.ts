import type { Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import { BuiryError, type ErrorCode } from '@buiry/core';
import type { AuthService } from '../auth/auth-service.js';
import { authenticateApiToken } from '../service/dashboard.js';
import { authenticateAgentToken } from '../service/auth.js';
import type { AgentRateLimiter, MemoryService } from '../service/memory-service.js';
import type { WebhookOpts } from '../service/webhooks.js';
import type { ByoOpts } from '../service/byo-storage.js';
import type { AgentPrincipal, ServiceDeps, UserPrincipal } from '../service/types.js';

export interface AppConfig {
  /** Origins allowed to make cookie-authenticated mutations (the dashboard). */
  allowedOrigins: string[];
  cookieSecure: boolean;
  enforcePlans: boolean;
  webhook?: WebhookOpts;
  /** Bring-your-own Walrus account checks (live probe, development-only private relayers). */
  storage?: ByoOpts;
  /** Shown in the storage and verification report (`/v1/projects/:id/evidence-report`). */
  evidence: {
    walrusNetwork?: string;
    delegatePublicKey?: string;
    relayerUrl?: string;
    tatumNetwork?: string;
  };
  /** SSE poll interval. */
  feedIntervalMs: number;
  /**
   * Proxies in front of the server that append to X-Forwarded-For (BUIRY_TRUSTED_PROXY_HOPS). 0 (default): use
   * the socket address and ignore the header. Behind one AWS ALB: 1.
   */
  trustedProxyHops: number;
  /** Open activity streams allowed per user and per project, in this process (SECURITY_REVIEW M3). */
  sseMaxPerUser: number;
  sseMaxPerProject: number;
  /** How often an open stream re-checks the caller's session and access; a failed check ends the stream. */
  sseRecheckMs: number;
}

/** Counts open streams per key; acquire refuses when any key is at its limit. Per process (per API task). */
export class StreamSlots {
  private readonly open = new Map<string, number>();
  acquire(limits: [key: string, max: number][]): () => void {
    for (const [k, max] of limits)
      if ((this.open.get(k) ?? 0) >= max)
        throw new BuiryError('rate_limited', 'too many open live streams; close one and try again', 5000);
    for (const [k] of limits) this.open.set(k, (this.open.get(k) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const [k] of limits) {
        const n = (this.open.get(k) ?? 1) - 1;
        if (n <= 0) this.open.delete(k);
        else this.open.set(k, n);
      }
    };
  }
  count(key: string): number {
    return this.open.get(key) ?? 0;
  }
}

export interface AppContext {
  deps: ServiceDeps;
  service: MemoryService;
  auth: AuthService;
  streams: StreamSlots;
  limiter: AgentRateLimiter;
  config: AppConfig;
}

export const SESSION_COOKIE = 'buiry_session';

export const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  rate_limited: 429,
  budget_exceeded: 429,
  redaction_blocked: 422,
  conflict: 409,
  storage_unavailable: 503,
  verification_unavailable: 503,
  invalid_input: 400,
  plan_limit: 402,
  internal: 500,
};

export type Caller =
  | { type: 'agent'; token: string }
  | { type: 'session'; userId: string; sessionId: string; viaCookie: boolean }
  | { type: 'api_token'; principal: UserPrincipal };

export interface RouteInfo {
  method: string;
  path: string;
  /** `public` needs no credentials; `agent` takes an agent token; `user` takes a session or API token. */
  auth: 'public' | 'agent' | 'user';
  /** How the route is scoped, for the isolation suite: which identifier decides the tenant. */
  scope:
    | 'none'
    | 'workspace'
    | 'project'
    | 'memory'
    | 'agent'
    | 'webhook'
    | 'delivery'
    | 'flag'
    | 'job'
    | 'token'
    | 'member'
    | 'session'
    | 'self';
}

export type Handler = (c: Context) => Promise<Response> | Response;

export function ok(c: Context, data: unknown, status: 200 | 201 = 200): Response {
  return c.json({ ok: true, data }, status);
}

export function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw new BuiryError(
      'invalid_input',
      r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
    );
  }
  return r.data;
}

/** Largest JSON request body accepted (packs included). Bodies are read with this cap, whatever Content-Length says. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

const tooLarge = () => new BuiryError('invalid_input', `request body is larger than ${MAX_BODY_BYTES} bytes`);

/** Reads the request body as text, refusing more than MAX_BODY_BYTES before buffering it all. */
export async function readCapped(req: Request, max = MAX_BODY_BYTES): Promise<string> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > max) throw tooLarge();
  if (!req.body) return '';
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString('utf8');
}

export async function body(c: Context): Promise<unknown> {
  const text = await readCapped(c.req.raw);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new BuiryError('invalid_input', 'request body is not valid JSON');
  }
}

export function bearer(c: Context): string | null {
  const h = c.req.header('authorization');
  return h && /^Bearer /i.test(h) ? h.slice(7).trim() : null;
}

/** Identify the caller without yet choosing a tenant. */
export async function caller(ctx: AppContext, c: Context): Promise<Caller> {
  const tok = bearer(c);
  if (tok) {
    if (tok.startsWith('bry_at_')) return { type: 'agent', token: tok };
    if (tok.startsWith('bry_pat_')) {
      const principal = await authenticateApiToken(ctx.deps, tok);
      if (!principal) throw new BuiryError('unauthorized', 'invalid API token');
      return { type: 'api_token', principal };
    }
    const s = await ctx.auth.resolveSession(tok);
    if (!s) throw new BuiryError('unauthorized', 'invalid or expired session');
    return { type: 'session', userId: s.userId, sessionId: s.sessionId, viaCookie: false };
  }
  const cookie = getCookie(c, SESSION_COOKIE);
  if (cookie) {
    const s = await ctx.auth.resolveSession(cookie);
    if (!s) throw new BuiryError('unauthorized', 'invalid or expired session');
    // Cookie-authenticated writes must come from an allowed origin (CSRF defence in depth on top of SameSite).
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin');
      if (!origin || !ctx.config.allowedOrigins.includes(origin))
        throw new BuiryError('forbidden', 'cross-origin request rejected');
    }
    return { type: 'session', userId: s.userId, sessionId: s.sessionId, viaCookie: true };
  }
  throw new BuiryError('unauthorized', 'authentication required');
}

export async function userCaller(ctx: AppContext, c: Context): Promise<Exclude<Caller, { type: 'agent' }>> {
  const who = await caller(ctx, c);
  if (who.type === 'agent') throw new BuiryError('forbidden', 'agent tokens only work on /v1/agent');
  return who;
}

/** Resolve the caller's principal in a workspace; non-members and unknown workspaces both look like not_found. */
export async function workspacePrincipal(
  ctx: AppContext,
  who: Exclude<Caller, { type: 'agent' }>,
  workspaceId: string,
): Promise<UserPrincipal> {
  if (who.type === 'api_token') {
    if (who.principal.workspaceId !== workspaceId) throw new BuiryError('not_found', 'workspace not found');
    return who.principal;
  }
  const p = await ctx.auth.principalFor(who.userId, workspaceId);
  if (!p) throw new BuiryError('not_found', 'workspace not found');
  return p;
}

export async function locate(
  ctx: AppContext,
  kind: 'project' | 'memory' | 'agent' | 'webhook' | 'delivery' | 'flag' | 'job' | 'token',
  id: string,
): Promise<{ workspaceId: string; projectId?: string } | null> {
  const q: Record<typeof kind, string> = {
    project: 'select workspace_id, id as project_id from projects where id = $1',
    memory: 'select workspace_id, project_id from memories where id = $1',
    agent: 'select workspace_id, project_id from agents where id = $1',
    webhook: 'select workspace_id, project_id from webhooks where id = $1',
    delivery: 'select workspace_id, null as project_id from webhook_deliveries where id = $1',
    flag: 'select workspace_id, project_id from flags where id = $1',
    job: 'select p.workspace_id, j.project_id from write_jobs j join projects p on p.id = j.project_id where j.id = $1',
    token: 'select workspace_id, null as project_id from api_tokens where id = $1',
  };
  const r = await ctx.deps.db.system((tx) =>
    tx.query<{ workspace_id: string; project_id: string | null }>(q[kind], [id]),
  );
  const row = r.rows[0];
  return row
    ? { workspaceId: row.workspace_id, ...(row.project_id ? { projectId: row.project_id } : {}) }
    : null;
}

/** Principal for an entity addressed by id. Unknown ids and other tenants' ids are indistinguishable (404). */
export async function entityPrincipal(
  ctx: AppContext,
  c: Context,
  kind: Parameters<typeof locate>[1],
  id: string,
) {
  const who = await userCaller(ctx, c);
  const loc = await locate(ctx, kind, id);
  if (!loc) throw new BuiryError('not_found', `${kind} not found`);
  const p = await workspacePrincipal(ctx, who, loc.workspaceId);
  return { p, loc, who };
}

export function agentBackendFor(ctx: AppContext, token: string, sessionId?: string) {
  return authenticateAgentToken(ctx.deps, token, sessionId);
}

export type RegisterFn = (info: RouteInfo, handler: Handler) => void;
export type Registrar = (app: Hono, ctx: AppContext, r: RegisterFn) => void;
export type { AgentPrincipal };
