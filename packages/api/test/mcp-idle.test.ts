import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createMcpHandler } from '@buiry/mcp';
import { Clock, createStack } from './helpers.js';

// SECURITY_REVIEW L1: MCP HTTP sessions are closed after an idle period; the client then re-initializes.

const rpc = (method: string, id: number, params: unknown = {}) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params });

describe('MCP session idle expiry', () => {
  it('closes a session idle longer than the limit and refuses its id afterwards', async () => {
    const c = new Clock();
    const s = await createStack({ now: c.now });
    const ws = await s.newWorkspace();
    const prj = await s.newProject(ws.id);
    const a = await s.newAgent({ workspaceId: ws.id, projectId: prj.id, name: 'mcp', tool: 'claude-code' });
    const mcp = createMcpHandler({ authenticate: (t) => s.backendFor(t), idleMs: 60_000, now: c.now });
    const server = createServer((req, res) => void mcp.handle(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
    const headers = {
      authorization: `Bearer ${a.token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    const init = await fetch(url, {
      method: 'POST',
      headers,
      body: rpc('initialize', 1, {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 't', version: '0' },
      }),
    });
    expect(init.status).toBe(200);
    await init.text();
    const sid = init.headers.get('mcp-session-id')!;
    expect(sid).toBeTruthy();
    const call = async () =>
      fetch(url, {
        method: 'POST',
        headers: { ...headers, 'mcp-session-id': sid },
        body: rpc('tools/list', 2),
      });
    const first = await call();
    expect(first.status).toBe(200);
    await first.text();
    expect(mcp.size).toBe(1);

    c.advance(30_000); // still active: the last request refreshed it
    const second = await call();
    expect(second.status).toBe(200);
    await second.text();

    c.advance(61_000);
    const late = await call();
    expect(late.status).toBe(404);
    expect(await late.text()).toContain('unknown session');
    expect(mcp.size).toBe(0);

    await mcp.closeAll();
    await new Promise((r) => server.close(r));
    await s.close();
  }, 60_000);
});
