import { Hono } from 'hono';
import { BuiryError } from '@buiry/core';
import { AuthService, type AuthConfig } from '../auth/auth-service.js';
import { AgentRateLimiter, MemoryService } from '../service/memory-service.js';
import type { ServiceDeps } from '../service/types.js';
import { STATUS, type AppConfig, type AppContext, type Handler, type RouteInfo } from './context.js';
import { registerAgent } from './routes-agent.js';
import { registerAuth } from './routes-auth.js';
import { registerProject } from './routes-project.js';
import { registerWorkspace } from './routes-workspace.js';

export interface CreateAppOptions {
  deps: ServiceDeps;
  auth: AuthConfig;
  config?: Partial<AppConfig>;
  agentCallsPerMinute?: number;
  /** Requests per minute per client address on /v1/auth (default 60). */
  authRequestsPerMinute?: number;
  publicRequestsPerMinute?: number;
}

export interface BuiryApp {
  app: Hono;
  routes: RouteInfo[];
  ctx: AppContext;
}

/** Small fixed-window limiter for unauthenticated endpoints, keyed by client address. */
class IpLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {}
  check(key: string): void {
    const t = this.now();
    const h = this.hits.get(key);
    if (!h || h.reset <= t) return void this.hits.set(key, { n: 1, reset: t + this.windowMs });
    if (++h.n > this.max)
      throw new BuiryError(
        'rate_limited',
        'too many requests; slow down',
        Math.ceil((h.reset - t) / 1000) * 1000,
      );
  }
}

export function createApp(o: CreateAppOptions): BuiryApp {
  const service = new MemoryService(o.deps);
  const ctx: AppContext = {
    deps: o.deps,
    service,
    auth: new AuthService(o.deps, o.auth),
    limiter: new AgentRateLimiter(o.agentCallsPerMinute ?? 600, o.deps.now),
    config: {
      allowedOrigins: [],
      cookieSecure: true,
      enforcePlans: true,
      evidence: {},
      feedIntervalMs: 1000,
      ...(o.config ?? {}),
    },
  };
  const app = new Hono();
  const routes: RouteInfo[] = [];
  const authLimiter = new IpLimiter(o.authRequestsPerMinute ?? 60, 60_000, o.deps.now);
  const publicLimiter = new IpLimiter(o.publicRequestsPerMinute ?? 120, 60_000, o.deps.now);

  app.use('*', async (c, next) => {
    const rid = c.req.header('x-request-id') ?? `req_${Math.random().toString(36).slice(2, 12)}`;
    c.header('x-request-id', rid);
    c.header('x-content-type-options', 'nosniff');
    c.header('cache-control', 'no-store');
    c.header('referrer-policy', 'no-referrer');
    await next();
  });
  const ipOf = (c: { req: { header: (n: string) => string | undefined } }) =>
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
  // Only the endpoints that take no credentials are limited per address; signed-in calls such as /auth/me are not.
  for (const path of ['/v1/auth/wallet/*', '/v1/auth/oauth/*', '/v1/auth/email/*'])
    app.use(path, async (c, next) => {
      authLimiter.check(ipOf(c));
      await next();
    });
  app.use('/v1/public/*', async (c, next) => {
    publicLimiter.check(ipOf(c));
    await next();
  });

  app.onError((e, c) => {
    const rid = c.res.headers.get('x-request-id') ?? c.req.header('x-request-id') ?? undefined;
    if (e instanceof BuiryError) {
      const headers: Record<string, string> = {};
      if (e.retryAfterMs) headers['retry-after'] = String(Math.ceil(e.retryAfterMs / 1000));
      return c.json(
        { ok: false, error: { ...e.toJSON(), ...(rid ? { requestId: rid } : {}) } },
        STATUS[e.code] as 400,
        headers,
      );
    }
    return c.json(
      {
        ok: false,
        error: { code: 'internal', message: 'internal error', ...(rid ? { requestId: rid } : {}) },
      },
      500,
    );
  });
  app.notFound((c) => c.json({ ok: false, error: { code: 'not_found', message: 'no such route' } }, 404));

  const register = (info: RouteInfo, handler: Handler) => {
    routes.push(info);
    const path = info.path;
    app.on(info.method, path, handler);
  };
  for (const reg of [registerAuth, registerAgent, registerWorkspace, registerProject])
    reg(app, ctx, register);
  return { app, routes, ctx };
}
