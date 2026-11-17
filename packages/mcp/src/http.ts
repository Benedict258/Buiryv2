// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { BuiryError, type BuiryBackend } from '@buiry/core';
import { createBuiryMcpServer } from './server.js';

export interface HttpOptions {
  /** Resolves the bearer token to that agent's backend. Throw BuiryError('unauthorized') for bad tokens. */
  authenticate: (token: string, sessionId: string) => Promise<BuiryBackend>;
  port?: number;
  host?: string;
  path?: string;
  /** Sessions with no request for this long are closed (default 30 minutes). Clients re-initialize. */
  idleMs?: number;
  now?: () => number;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  token: string;
  lastSeen: number;
}

/** Default idle lifetime of an MCP HTTP session (SECURITY_REVIEW L1). */
export const MCP_SESSION_IDLE_MS = 30 * 60_000;

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  return h && /^Bearer /i.test(h) ? h.slice(7).trim() : null;
}

/** Largest MCP request body accepted. */
export const MAX_MCP_BODY_BYTES = 1024 * 1024;

class BodyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (Number(req.headers['content-length'] ?? 0) > MAX_MCP_BODY_BYTES)
    throw new BodyError(413, 'request body too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_MCP_BODY_BYTES) throw new BodyError(413, 'request body too large');
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new BodyError(400, 'request body is not valid JSON');
  }
}

const deny = (res: ServerResponse, status: number, message: string) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
};

export type McpRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** Request handler for a Streamable HTTP MCP endpoint. Each MCP session is bound to the bearer token that opened it. */
export function createMcpHandler(o: Pick<HttpOptions, 'authenticate' | 'idleMs' | 'now'>): {
  handle: McpRequestHandler;
  closeAll: () => Promise<void>;
  /** Closes sessions idle longer than idleMs; runs on every request and on a timer. Returns how many closed. */
  sweep: () => number;
  readonly size: number;
} {
  const sessions = new Map<string, Session>();
  const idleMs = o.idleMs ?? MCP_SESSION_IDLE_MS;
  const now = o.now ?? Date.now;
  const sweep = () => {
    let closed = 0;
    for (const [id, s] of sessions)
      if (now() - s.lastSeen > idleMs) {
        sessions.delete(id);
        void s.transport.close().catch(() => {});
        closed++;
      }
    return closed;
  };
  const timer = setInterval(sweep, Math.min(idleMs, 60_000));
  timer.unref();
  const handle: McpRequestHandler = async (req, res) => {
    sweep();
    const token = bearer(req);
    if (!token) return deny(res, 401, 'missing bearer token');
    const sid = req.headers['mcp-session-id'] as string | undefined;
    try {
      if (sid) {
        const s = sessions.get(sid);
        if (!s) return deny(res, 404, 'unknown session');
        s.lastSeen = now();
        if (s.token !== token) return deny(res, 403, 'session belongs to a different token');
        return await s.transport.handleRequest(
          req,
          res,
          req.method === 'POST' ? await readJson(req) : undefined,
        );
      }
      if (req.method !== 'POST') return deny(res, 400, 'session id required');
      const body = await readJson(req);
      if (!isInitializeRequest(body)) return deny(res, 400, 'first request must initialize');
      const id = randomUUID();
      const backend = await o.authenticate(token, id);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => id,
        onsessioninitialized: (s) => void sessions.set(s, { transport, token, lastSeen: now() }),
      });
      transport.onclose = () => void sessions.delete(id);
      await createBuiryMcpServer({ backend }).connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (res.headersSent) return;
      if (e instanceof BodyError) {
        res.setHeader('connection', 'close');
        return deny(res, e.status, e.message);
      }
      if (e instanceof BuiryError && e.code === 'unauthorized') return deny(res, 401, e.message);
      // Never echo an unexpected error to the client (it can quote internal detail); log its class only.
      const rid = randomUUID();
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'mcp_server_error',
          requestId: rid,
          error: (e as Error)?.name ?? typeof e,
        }),
      );
      deny(res, 500, `internal error (request ${rid})`);
    }
  };
  return {
    handle,
    sweep,
    get size() {
      return sessions.size;
    },
    closeAll: async () => {
      clearInterval(timer);
      for (const s of sessions.values()) await s.transport.close().catch(() => {});
    },
  };
}

/** Standalone Streamable HTTP endpoint (used by tests and `buiry-mcp --http`). */
export async function startHttpServer(
  o: HttpOptions,
): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const path = o.path ?? '/mcp';
  const h = createMcpHandler(o);
  const server = createServer((req, res) => {
    if (!req.url?.startsWith(path)) return deny(res, 404, 'not found');
    void h.handle(req, res);
  });
  await new Promise<void>((r) => server.listen(o.port ?? 0, o.host ?? '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    url: `http://${o.host ?? '127.0.0.1'}:${port}${path}`,
    close: async () => {
      await h.closeAll();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
