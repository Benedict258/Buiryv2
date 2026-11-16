import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { createMcpHandler } from '@buiry/mcp';
import { createGatewayIfConfigured, suiNetwork } from '@buiry/chain';
import {
  Ed25519Signer,
  HttpWalrusAdapter,
  SealSessionProvider,
  type WalrusMemoryAdapter,
} from '@buiry/storage';
import { BuiryError } from '@buiry/core';
import { MemoryMailer, type Mailer } from './auth/auth-service.js';
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
  const dev = env.NODE_ENV !== 'production';
  if (dev && (!env.BUIRY_MAILER || env.BUIRY_MAILER === 'console')) return new ConsoleMailer();
  return new UnconfiguredMailer();
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
  const gateway = createGatewayIfConfigured(env, { sink: tatumCallSink(deps) });
  if (gateway) deps.gateway = gateway;
  let adapter: WalrusMemoryAdapter | undefined;
  if (env.WALRUS_RELAYER_URL && env.WALRUS_DELEGATE_KEY && env.WALRUS_ACCOUNT_ID) {
    const http = new HttpWalrusAdapter({
      baseUrl: env.WALRUS_RELAYER_URL,
      accountId: env.WALRUS_ACCOUNT_ID,
      signer: new Ed25519Signer(env.WALRUS_DELEGATE_KEY),
    });
    // Recall needs a Seal session (A23). Its one Sui read (the relayer package must be version 1) goes through the
    // chain gateway; without a gateway, recall is served from Buiry's index and flagged as cached.
    if (gateway) {
      http.useSealSession(
        new SealSessionProvider({
          delegateKey: env.WALRUS_DELEGATE_KEY,
          relayerConfig: () => http.relayerConfig(),
          packageVersion: async (objectId, network) => {
            const r = await gateway.getObject(objectId, { network: suiNetwork(network) });
            if (!r.value.found) throw new Error('relayer Seal package not found on chain');
            return String(r.value.object.version);
          },
        }),
      );
    } else {
      console.warn(
        '[buiry] no Tatum gateway configured: Walrus recall cannot build a Seal session and will be served from the index',
      );
    }
    adapter = http;
    deps.adapter = adapter;
  }
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
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/mcp')) void mcp.handle(req, res);
    else if (staticDir && req.method === 'GET' && !req.url?.startsWith('/v1/'))
      serveStatic(staticDir, req.url ?? '/', res);
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
