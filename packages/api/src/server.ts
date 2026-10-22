import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { createMcpHandler } from '@buiry/mcp';
import { createGatewayIfConfigured } from '@buiry/chain';
import { Ed25519Signer, HttpWalrusAdapter, type WalrusMemoryAdapter } from '@buiry/storage';
import { MemoryMailer, type Mailer } from './auth/auth-service.js';
import { GitHubOAuth, GoogleOAuth, type OAuthProvider } from './auth/oauth.js';
import { SuiPersonalMessageVerifier } from './auth/wallet.js';
import { PgDb, PgliteDb, type Db } from './db/db.js';
import { createApp, type BuiryApp } from './http/app.js';
import { authenticateAgentToken } from './service/auth.js';
import { tatumCallSink } from './service/dashboard.js';
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

/** Console mailer for development: prints the sign-in link (no SMTP integration is claimed). */
export class ConsoleMailer implements Mailer {
  async sendMagicLink(to: string, link: string): Promise<void> {
    console.log(`[buiry] sign-in link for ${to}: ${link}`);
  }
}

/** Builds service dependencies from the documented environment variables. Nothing is read from files. */
export async function buildRuntime(env: Env = process.env): Promise<Runtime> {
  let db: Db;
  if (env.DATABASE_URL) {
    const pg = PgDb.fromUrl(env.DATABASE_URL);
    await pg.migrate();
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
  let adapter: WalrusMemoryAdapter | undefined;
  if (env.WALRUS_RELAYER_URL && env.WALRUS_DELEGATE_KEY && env.WALRUS_ACCOUNT_ID) {
    adapter = new HttpWalrusAdapter({
      baseUrl: env.WALRUS_RELAYER_URL,
      accountId: env.WALRUS_ACCOUNT_ID,
      signer: new Ed25519Signer(env.WALRUS_DELEGATE_KEY),
    });
    deps.adapter = adapter;
  }
  const gateway = createGatewayIfConfigured(env, { sink: tatumCallSink(deps) });
  if (gateway) deps.gateway = gateway;
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
      mailer: rt.env.BUIRY_MAILER === 'memory' ? new MemoryMailer() : new ConsoleMailer(),
    },
    config: {
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
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/mcp')) void mcp.handle(req, res);
    else void rest(req, res);
  });
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
