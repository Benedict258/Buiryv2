import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMcpHandler } from '@buiry/mcp';
import { createApp, FakeWalletVerifier, MemoryMailer, type Db } from '../src/index.js';
import { createStack, type Stack } from './helpers.js';

// SECURITY_REVIEW M5: unexpected errors are logged with a request id and without their message (database errors
// can quote memory text or other values); the client only sees a generic message.

const LEAK = 'SECRET-memory-text-do-not-log';
let s: Stack;
const lines: string[] = [];
beforeAll(async () => {
  s = await createStack({});
  vi.spyOn(console, 'error').mockImplementation(
    (...a: unknown[]) => void lines.push(a.map(String).join(' ')),
  );
}, 60_000);
afterAll(async () => {
  vi.restoreAllMocks();
  await s.close();
});

/** An app whose database fails every query with an error that quotes a value, like a Postgres constraint error. */
function failingApp() {
  const boom = Object.assign(new Error(`duplicate key value (text)=(${LEAK})`), { code: '23505' });
  const db: Db = {
    tenant: () => Promise.reject(boom),
    system: () => Promise.reject(boom),
    close: () => Promise.resolve(),
  };
  return createApp({
    deps: { ...s.deps, db },
    auth: {
      domain: 'x',
      baseUrl: 'https://x',
      wallet: new FakeWalletVerifier(),
      providers: {},
      mailer: new MemoryMailer(),
    },
  });
}

const emailStart = (headers: Record<string, string> = {}) =>
  failingApp().app.request('/v1/auth/email/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ email: 'someone@example.com' }),
  });

describe('server errors', () => {
  it('logs a 500 with the request id, route and code, never the message, and answers generically', async () => {
    lines.length = 0;
    const res = await emailStart();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string; requestId: string } };
    expect(body.error.message).toBe('internal error');
    expect(body.error.requestId).toBe(res.headers.get('x-request-id'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: 'error',
      event: 'server_error',
      requestId: body.error.requestId,
      method: 'POST',
      route: '/v1/auth/email/start',
      error: 'Error',
      code: '23505',
    });
    expect(lines[0]).not.toContain(LEAK);
    expect(JSON.stringify(body)).not.toContain(LEAK);
  });

  it('does not let a client-supplied request id forge log content', async () => {
    lines.length = 0;
    const forged = await emailStart({ 'x-request-id': 'abc"}{"level":"info"' });
    expect(forged.headers.get('x-request-id')).toMatch(/^req_/);
    expect(JSON.parse(lines[0]!).requestId).toMatch(/^req_/);
    const kept = await emailStart({ 'x-request-id': 'trace-123' });
    expect(kept.headers.get('x-request-id')).toBe('trace-123');
  });

  it('the MCP endpoint answers an unexpected error generically', async () => {
    lines.length = 0;
    const mcp = createMcpHandler({
      authenticate: async () => {
        throw new Error(`internal detail ${LEAK}`);
      },
    });
    const server = createServer((req, res) => void mcp.handle(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer t',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    });
    const text = await r.text();
    expect(r.status).toBe(500);
    expect(text).toContain('internal error');
    expect(text).not.toContain(LEAK);
    expect(lines.join('\n')).not.toContain(LEAK);
    await new Promise((res) => server.close(res));
  });
});
