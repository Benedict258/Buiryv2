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
}

interface Session {
  transport: StreamableHTTPServerTransport;
  token: string;
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  return h && /^Bearer /i.test(h) ? h.slice(7).trim() : null;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

const deny = (res: ServerResponse, status: number, message: string) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
};

/** Streamable HTTP endpoint. Each MCP session is bound to the bearer token that opened it. */
export async function startHttpServer(
  o: HttpOptions,
): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const sessions = new Map<string, Session>();
  const path = o.path ?? '/mcp';
  const server = createServer((req, res) => {
    void (async () => {
      if (!req.url?.startsWith(path)) return deny(res, 404, 'not found');
      const token = bearer(req);
      if (!token) return deny(res, 401, 'missing bearer token');
      const sid = req.headers['mcp-session-id'] as string | undefined;
      try {
        if (sid) {
          const s = sessions.get(sid);
          if (!s) return deny(res, 404, 'unknown session');
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
          onsessioninitialized: (s) => void sessions.set(s, { transport, token }),
        });
        transport.onclose = () => void sessions.delete(id);
        await createBuiryMcpServer({ backend }).connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e) {
        if (res.headersSent) return;
        if (e instanceof BuiryError && e.code === 'unauthorized') return deny(res, 401, e.message);
        deny(res, 500, e instanceof Error ? e.message : 'internal error');
      }
    })();
  });
  await new Promise<void>((r) => server.listen(o.port ?? 0, o.host ?? '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    url: `http://${o.host ?? '127.0.0.1'}:${port}${path}`,
    close: async () => {
      for (const s of sessions.values()) await s.transport.close().catch(() => {});
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
