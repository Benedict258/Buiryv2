import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { BuiryError } from '@buiry/core';
import { AuthService, type AuthConfig } from '../auth/auth-service.js';
import { AgentRateLimiter, MemoryService } from '../service/memory-service.js';
import type { ServiceDeps } from '../service/types.js';
import {
  STATUS,
  StreamSlots,
  type AppConfig,
  type AppContext,
  type Handler,
  type RouteInfo,
} from './context.js';
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

/**
 * The client address used for per-address limits. With no trusted proxies (the default) it is the socket peer and
 * X-Forwarded-For is ignored, since any client can send it. Behind N trusted proxies that each append the address
 * they received from (the AWS ALB does), the client is the Nth entry from the right; entries further left were
 * written by the client and are never used.
 */
export function clientAddress(c: Parameters<Handler>[0], trustedProxyHops: number): string {
  let socket = 'local';
  try {
    socket = getConnInfo(c).remote.address ?? 'local';
  } catch {
    // Not served by the Node adapter (in-process tests): no socket address.
  }
  if (trustedProxyHops <= 0) return socket;
  const hops = (c.req.header('x-forwarded-for') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return hops.length >= trustedProxyHops ? hops[hops.length - trustedProxyHops]! : socket;
}

/**
 * One JSON line per unexpected server error: request id, method, route pattern (never the concrete URL, which can
 * carry ids or query text), error class, Postgres code and stack frames. The error message is left out on purpose.
 */
export function logServerError(
  e: unknown,
  at: { requestId?: string | undefined; method?: string; route?: string },
  log: (line: string) => void = (l) => console.error(l),
): void {
  const err = e as { name?: string; code?: unknown; stack?: string };
  const frames = (err.stack ?? '')
    .split('\n')
    .filter((l) => /^\s+at /.test(l))
    .slice(0, 8)
    .map((l) => l.trim());
  log(
    JSON.stringify({
      level: 'error',
      event: 'server_error',
      requestId: at.requestId ?? null,
      method: at.method ?? null,
      route: at.route ?? null,
      error: err.name ?? typeof e,
      ...(typeof err.code === 'string' && /^[A-Z0-9_]{1,12}$/.test(err.code) ? { code: err.code } : {}),
      frames,
    }),
  );
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
    streams: new StreamSlots(),
    limiter: new AgentRateLimiter(o.agentCallsPerMinute ?? 600, o.deps.now),
    config: {
      allowedOrigins: [],
      cookieSecure: true,
      enforcePlans: true,
      evidence: {},
      feedIntervalMs: 1000,
      trustedProxyHops: 0,
      sseMaxPerUser: 5,
      sseMaxPerProject: 50,
      sseRecheckMs: 15_000,
      ...(o.config ?? {}),
    },
  };
  const app = new Hono();
  const routes: RouteInfo[] = [];
  const authLimiter = new IpLimiter(o.authRequestsPerMinute ?? 60, 60_000, o.deps.now);
  const publicLimiter = new IpLimiter(o.publicRequestsPerMinute ?? 120, 60_000, o.deps.now);

  app.use('*', async (c, next) => {
    // A client-supplied request id is kept only if it is short and plain, so it cannot forge log lines.
    const given = c.req.header('x-request-id');
    const rid =
      given && /^[A-Za-z0-9_.-]{1,64}$/.test(given)
        ? given
        : `req_${Math.random().toString(36).slice(2, 12)}`;
    c.header('x-request-id', rid);
    c.header('x-content-type-options', 'nosniff');
    c.header('cache-control', 'no-store');
    c.header('referrer-policy', 'no-referrer');
    const t0 = performance.now();
    await next();
    const log = ctx.config.requestLog;
    if (log) {
      const status = c.res.status;
      // The matched route pattern, never the concrete path; the project id is an id, not content.
      const route = c.req.matchedRoutes.filter((r) => r.method !== 'ALL').at(-1)?.path ?? 'unmatched';
      const project = /^\/v1\/projects\/(prj_[0-9A-Z]{26})(?:\/|$)/.exec(c.req.path)?.[1];
      const err = c.error;
      const error =
        status < 400
          ? undefined
          : err instanceof BuiryError
            ? err.code
            : err
              ? /^[A-Za-z0-9_]{1,64}$/.test(err.name)
                ? err.name
                : 'Error'
              : status === 404
                ? 'not_found'
                : `http_${status}`;
      log(
        JSON.stringify({
          level: status >= 500 ? 'error' : 'info',
          event: 'request',
          requestId: rid,
          method: c.req.method,
          route,
          status,
          ms: Math.round(performance.now() - t0),
          ...(project ? { project } : {}),
          ...(error ? { error } : {}),
        }),
      );
    }
  });
  const ipOf = (c: Parameters<Handler>[0]) => clientAddress(c, ctx.config.trustedProxyHops);
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
    const rid = c.res.headers.get('x-request-id') ?? undefined;
    if (e instanceof BuiryError) {
      const headers: Record<string, string> = {};
      if (e.retryAfterMs) headers['retry-after'] = String(Math.ceil(e.retryAfterMs / 1000));
      return c.json(
        { ok: false, error: { ...e.toJSON(), ...(rid ? { requestId: rid } : {}) } },
        STATUS[e.code] as 400,
        headers,
      );
    }
    // M5: unexpected errors are logged with the request id so they can be traced; the client gets a generic
    // message. The error message itself is not logged: database errors can quote row values (memory text).
    logServerError(e, { requestId: rid, method: c.req.method, route: c.req.routePath });
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
