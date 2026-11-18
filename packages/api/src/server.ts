import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { createMcpHandler } from '@buiry/mcp';
import { createGatewayIfConfigured } from '@buiry/chain';
import { Ed25519Signer, HttpWalrusAdapter, type WalrusMemoryAdapter } from '@buiry/storage';
import { BuiryError } from '@buiry/core';
import { MemoryMailer, type Mailer } from './auth/auth-service.js';
import { productionProblems } from './config-check.js';
import { cspModeFromEnv, requestIsHttps, securityHeaders } from './http/security-headers.js';
import { SmtpMailer, smtpConfigFromEnv } from './auth/smtp.js';
import { StorageRegistry } from './service/byo-storage.js';
import { buildWalrusAdapter } from './service/walrus.js';
import { GitHubOAuth, GoogleOAuth, type OAuthProvider } from './auth/oauth.js';
import { SuiPersonalMessageVerifier } from './auth/wallet.js';
import { PgDb, PgliteDb, type Db } from './db/db.js';
import { createApp, type BuiryApp } from './http/app.js';
import { authenticateAgentToken } from './service/auth.js';
import { tatumCallSink } from './service/dashboard.js';
import { checkRuntimeNetworks } from './service/networks.js';
import { AgentBackend } from './service/memory-service.js';
import type { ServiceDeps } from './service/types.js';

type Env = Record<string, string | undefined>;

export interface Runtime {
  deps: ServiceDeps;
  adapter?: WalrusMemoryAdapter;
  db: Db;
  env: Env;
  close: () => Promise<void>;
}

/** Console mailer for development: prints the sign-in link (no SMTP integration is claimed). Never used in production. */
export class ConsoleMailer implements Mailer {
  async sendMagicLink(to: string, link: string): Promise<void> {
    console.log(`[buiry] sign-in link for ${to}: ${link}`);
  }
}

/** Production without a configured mailer: email sign-in is refused, and the link (a bearer secret) is never logged. */
export class UnconfiguredMailer implements Mailer {
  async sendMagicLink(): Promise<void> {
    throw new BuiryError('internal', 'email sign-in is not configured on this server');
  }
}

/** Picks the mailer from the environment. The console mailer prints tokens, so production never gets it. */
export function mailerFromEnv(env: Env): Mailer {
  if (env.BUIRY_MAILER === 'memory') return new MemoryMailer();
  if (env.BUIRY_MAILER === 'smtp') return new SmtpMailer(smtpConfigFromEnv(env));
  const dev = env.NODE_ENV !== 'production';
  if (dev && (!env.BUIRY_MAILER || env.BUIRY_MAILER === 'console')) return new ConsoleMailer();
  return new UnconfiguredMailer();
}

/** Builds service dependencies from the documented environment variables. Nothing is read from files. */
export async function buildRuntime(env: Env = process.env): Promise<Runtime> {
  const production = env.NODE_ENV === 'production';
  if (production) {
    const problems = productionProblems(env);
    if (problems.length)
      throw new Error(
        ['[buiry] refusing to start in production:', ...problems.map((x) => ` - ${x}`)].join('\n'),
      );
  }
  let db: Db;
  if (env.DATABASE_URL) {
    const pg = PgDb.fromUrl(env.DATABASE_URL);
    // In production the migration task applies migrations (scripts: buiry-migrate); servers only check, so several
    // tasks starting together never race on the schema. BUIRY_MIGRATE_ON_START=1 restores migrate-on-start.
    if (!production || env.BUIRY_MIGRATE_ON_START === '1') await pg.migrate();
    else {
      const pending = await pg.pending();
      if (pending.length)
        throw new Error(
          `[buiry] refusing to start: ${pending.length} database migration(s) pending (${pending.join(', ')}); run the migration task first`,
        );
    }
    db = pg;
  } else {
    console.warn('[buiry] DATABASE_URL is not set: using an in-memory database (data is lost on exit)');
    db = await PgliteDb.create();
  }
  const secretKey = env.BUIRY_SECRET_KEY ?? '';
  if (secretKey.length < 32) {
    if (env.NODE_ENV === 'production')
      throw new Error('BUIRY_SECRET_KEY must be set to at least 32 characters');
    console.warn('[buiry] BUIRY_SECRET_KEY is unset or short: using a random development key');
  }
  const deps: ServiceDeps = {
    db,
    now: Date.now,
    random: (n) => new Uint8Array(randomBytes(n)),
    secretKey: secretKey.length >= 32 ? secretKey : randomBytes(32).toString('hex'),
  };
  // During a BUIRY_SECRET_KEY rotation the previous key is still accepted (docs/KEY_CUSTODY.md, runbook).
  const previous = env.BUIRY_SECRET_KEY_PREVIOUS ?? '';
  if (previous.length >= 32 && previous !== deps.secretKey) deps.previousSecretKey = previous;
  if (env.BUIRY_RENEWAL === 'on') deps.renewalEnabled = true;
  if (env.BUIRY_PACK_MAX_ITEMS) deps.packMaxItems = Number(env.BUIRY_PACK_MAX_ITEMS);
  // Agent tokens expire after BUIRY_AGENT_TOKEN_MAX_DAYS (default 90; 0 = no expiry). Rotation revokes at once.
  const maxDays = Number(env.BUIRY_AGENT_TOKEN_MAX_DAYS ?? 90);
  if (maxDays > 0) deps.agentTokenMaxDays = maxDays;
  const gateway = createGatewayIfConfigured(env, { sink: tatumCallSink(deps) });
  if (gateway) deps.gateway = gateway;
  let adapter: WalrusMemoryAdapter | undefined;
  // BUIRY_MANAGED=off: no shared account even when WALRUS_* are present (first deploy, BD42).
  if (
    env.BUIRY_MANAGED !== 'off' &&
    env.WALRUS_RELAYER_URL &&
    env.WALRUS_DELEGATE_KEY &&
    env.WALRUS_ACCOUNT_ID
  ) {
    adapter = buildWalrusAdapter(
      {
        relayerUrl: env.WALRUS_RELAYER_URL,
        accountId: env.WALRUS_ACCOUNT_ID,
        delegateKey: env.WALRUS_DELEGATE_KEY,
      },
      gateway,
    );
    if (!gateway)
      console.warn(
        '[buiry] no Tatum gateway configured: Walrus recall cannot build a Seal session and will be served from the index',
      );
    deps.adapter = adapter;
  }
  // Projects may bring their own Walrus Memory account. The managed account serves one workspace unless
  // BUIRY_MANAGED_MULTI_TENANT=1 (one account's Seal session reaches every tenant on it, A26).
  deps.storage = new StorageRegistry({
    ...(adapter ? { managed: adapter } : {}),
    build: (cfg) => buildWalrusAdapter(cfg, gateway),
    tenancy: {
      multi: env.BUIRY_MANAGED_MULTI_TENANT === '1',
      ...(env.BUIRY_MANAGED_WORKSPACE_ID ? { workspaceId: env.BUIRY_MANAGED_WORKSPACE_ID } : {}),
    },
    ...(env.BUIRY_BYO_ADAPTER_CACHE ? { maxCached: Number(env.BUIRY_BYO_ADAPTER_CACHE) } : {}),
  });
  // Refuse to start when Walrus, the gateway, the relayer, the demo or a project point at different Sui networks.
  const net = await checkRuntimeNetworks({
    env,
    db,
    gatewayConfigured: !!gateway,
    ...(adapter instanceof HttpWalrusAdapter ? { relayerConfig: () => adapter.relayerConfig() } : {}),
  });
  if (net.mismatches.length) {
    gateway?.close();
    await db.close();
    throw new Error(`[buiry] refusing to start, network mismatch: ${net.mismatches.join('; ')}`);
  }
  deps.networks = net.networks;
  return {
    deps,
    ...(adapter ? { adapter } : {}),
    db,
    env,
    close: async () => {
      (deps.gateway as { close?: () => void } | undefined)?.close?.();
      await db.close();
    },
  };
}

export function buildApp(rt: Runtime): BuiryApp {
  const baseUrl = rt.env.BUIRY_BASE_URL ?? 'http://localhost:8787';
  const providers: Partial<Record<'github' | 'google', OAuthProvider>> = {};
  if (rt.env.GITHUB_CLIENT_ID && rt.env.GITHUB_CLIENT_SECRET)
    providers.github = new GitHubOAuth({
      clientId: rt.env.GITHUB_CLIENT_ID,
      clientSecret: rt.env.GITHUB_CLIENT_SECRET,
    });
  if (rt.env.GOOGLE_CLIENT_ID && rt.env.GOOGLE_CLIENT_SECRET)
    providers.google = new GoogleOAuth({
      clientId: rt.env.GOOGLE_CLIENT_ID,
      clientSecret: rt.env.GOOGLE_CLIENT_SECRET,
    });
  const delegatePublicKey = rt.env.WALRUS_DELEGATE_KEY
    ? new Ed25519Signer(rt.env.WALRUS_DELEGATE_KEY).publicKeyHex
    : undefined;
  return createApp({
    deps: rt.deps,
    auth: {
      domain: new URL(baseUrl).host,
      baseUrl,
      wallet: new SuiPersonalMessageVerifier(),
      providers,
      mailer: mailerFromEnv(rt.env),
    },
    config: {
      trustedProxyHops: Number(rt.env.BUIRY_TRUSTED_PROXY_HOPS ?? 0),
      ...(rt.env.BUIRY_SSE_MAX_PER_USER ? { sseMaxPerUser: Number(rt.env.BUIRY_SSE_MAX_PER_USER) } : {}),
      ...(rt.env.BUIRY_SSE_MAX_PER_PROJECT
        ? { sseMaxPerProject: Number(rt.env.BUIRY_SSE_MAX_PER_PROJECT) }
        : {}),
      storage: {
        // Development only: a relayer on localhost or a private address (refused in production).
        allowPrivate: rt.env.BUIRY_BYO_ALLOW_PRIVATE === '1' && rt.env.NODE_ENV !== 'production',
        // Before saving, the relayer must answer and report the account's network.
        // Before saving: the relayer answers, reports the account's network, and accepts a signed read with this
        // delegate key for this account.
        probe: async (cfg) => {
          const a = new HttpWalrusAdapter({
            baseUrl: cfg.relayerUrl,
            accountId: cfg.accountId,
            signer: new Ed25519Signer(cfg.delegateKey),
          });
          const conf = await a.relayerConfig();
          await a.list({ limit: 1 });
          return conf;
        },
      },
      allowedOrigins: (rt.env.BUIRY_ALLOWED_ORIGINS ?? baseUrl).split(',').map((s) => s.trim()),
      cookieSecure: baseUrl.startsWith('https://'),
      enforcePlans: rt.env.BUIRY_ENTITLEMENTS !== 'off',
      evidence: {
        ...(rt.env.WALRUS_NETWORK ? { walrusNetwork: rt.env.WALRUS_NETWORK } : {}),
        ...(delegatePublicKey ? { delegatePublicKey } : {}),
        ...(rt.env.WALRUS_RELAYER_URL ? { relayerUrl: rt.env.WALRUS_RELAYER_URL } : {}),
        ...(rt.env.TATUM_NETWORK ? { tatumNetwork: rt.env.TATUM_NETWORK } : {}),
      },
    },
  });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Serves the built dashboard; unknown paths fall back to index.html so client-side routes work. */
function serveStatic(root: string, url: string, res: import('node:http').ServerResponse): void {
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.split('?')[0]!);
  } catch {
    // A malformed escape such as `/%E0%A4%A` must not throw inside the raw request listener.
    res.writeHead(400, { 'content-type': 'text/plain' }).end('bad request');
    return;
  }
  const path = normalize(decoded).replace(/^([/\\]\.\.)+/, '');
  let file = join(root, path);
  if (!(file === root || file.startsWith(root + sep)) || !existsSync(file) || statSync(file).isDirectory())
    file = join(root, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404).end('dashboard not built');
    return;
  }
  const immutable = file.includes(`${join(root, 'assets')}`);
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  createReadStream(file).pipe(res);
}

/** One HTTP server: REST under /v1, MCP Streamable HTTP under /mcp. */
export async function startHttp(
  rt: Runtime,
  port = Number(rt.env.PORT ?? 8787),
): Promise<{ server: Server; url: string; app: BuiryApp; close: () => Promise<void> }> {
  const app = buildApp(rt);
  const rest = getRequestListener(app.app.fetch);
  const mcp = createMcpHandler({
    authenticate: async (token, sessionId) =>
      new AgentBackend(
        app.ctx.service,
        await authenticateAgentToken(rt.deps, token, sessionId),
        app.ctx.limiter,
      ),
  });
  const staticDir = rt.env.DASHBOARD_DIR ? resolve(rt.env.DASHBOARD_DIR) : undefined;
  const csp = cspModeFromEnv(rt.env);
  const hops = Number(rt.env.BUIRY_TRUSTED_PROXY_HOPS ?? 0);
  const server = createServer((req, res) => {
    // Phase 2.3: one place, so REST, MCP, the dashboard's static files and every error answer carry them.
    for (const [k, v] of Object.entries(securityHeaders({ https: requestIsHttps(req, hops), csp })))
      res.setHeader(k, v);
    if (req.url?.startsWith('/mcp')) void mcp.handle(req, res);
    else if (staticDir && req.method === 'GET' && !req.url?.startsWith('/v1/'))
      serveStatic(staticDir, req.url ?? '/', res);
    else void rest(req, res);
  });
  // Keep idle connections open longer than clients and load balancers do (the AWS ALB idle timeout defaults to
  // 60 s), so the server never closes a socket a client is about to reuse; that race surfaced as ECONNRESET.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  await new Promise<void>((r) => server.listen(port, r));
  const actual = (server.address() as { port: number }).port;
  return {
    server,
    app,
    url: `http://localhost:${actual}`,
    close: async () => {
      await mcp.closeAll();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
