// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { BuiryError } from '@buiry/core';
import { RestBackend, toolError, schemas } from '../src/index.js';
import { z } from 'zod';

const reply = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('RestBackend', () => {
  it('sends the bearer token and session id, and unwraps data', async () => {
    let seen: { url: string; headers: Record<string, string>; body: string } | undefined;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string>, body: String(init.body) };
      return new Response(JSON.stringify({ ok: true, data: { memoryId: 'mem_1' } }), { status: 200 });
    }) as unknown as typeof fetch;
    const b = new RestBackend({
      baseUrl: 'https://api.example/',
      token: 'bry_at_x',
      sessionId: 's1',
      fetch: f,
    });
    expect(await b.remember({ text: 'hi', type: 'fact' })).toEqual({ memoryId: 'mem_1' });
    expect(seen!.url).toBe('https://api.example/v1/agent/remember');
    expect(seen!.headers.authorization).toBe('Bearer bry_at_x');
    expect(seen!.headers['x-buiry-session']).toBe('s1');
    expect(JSON.parse(seen!.body)).toEqual({ text: 'hi', type: 'fact' });
  });

  it('maps API errors to stable BuiryError codes with retry hints', async () => {
    const b = new RestBackend({
      baseUrl: 'http://x',
      token: 't',
      fetch: reply(429, { ok: false, error: { code: 'rate_limited', message: 'slow', retryAfterMs: 5000 } }),
    });
    const e = (await b.status().catch((x) => x)) as BuiryError;
    expect(e).toBeInstanceOf(BuiryError);
    expect([e.code, e.retryAfterMs]).toEqual(['rate_limited', 5000]);
    const unknown = new RestBackend({
      baseUrl: 'http://x',
      token: 't',
      fetch: reply(401, { ok: false, error: { code: 'weird', message: 'no' } }),
    });
    expect(((await unknown.status().catch((x) => x)) as BuiryError).code).toBe('unauthorized');
  });

  it('treats an unreachable service as storage_unavailable so the agent can continue without memory', async () => {
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const e = (await new RestBackend({ baseUrl: 'http://x', token: 't', fetch: down })
      .check({})
      .catch((x) => x)) as BuiryError;
    expect(e.code).toBe('storage_unavailable');
    expect(e.message).toMatch(/continue without project memory/);
    const html = (async () =>
      new Response('<html>bad gateway</html>', { status: 502 })) as unknown as typeof fetch;
    expect(
      (
        (await new RestBackend({ baseUrl: 'http://x', token: 't', fetch: html })
          .check({})
          .catch((x) => x)) as BuiryError
      ).code,
    ).toBe('storage_unavailable');
  });
});

describe('tool errors and schemas', () => {
  it('toolError carries the stable code, message and retry hint', () => {
    const r = toolError(new BuiryError('budget_exceeded', 'slow down', 4000));
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toBe('budget_exceeded: slow down Retry after 4s.');
    expect(r.structuredContent).toEqual({
      error: { code: 'budget_exceeded', message: 'slow down', retryAfterMs: 4000 },
    });
    // Sweep A2 (Phase 5.4): a non-Buiry error's message never reaches the agent; only class and code are logged.
    const logged: string[] = [];
    expect(toolError(new Error('boom'), (l) => logged.push(l)).structuredContent).toEqual({
      error: { code: 'internal', message: 'internal error' },
    });
    expect(logged).toEqual(['{"level":"error","event":"tool_error","error":"Error"}']);
  });

  it('remember schema accepts typed evidence and rejects unknown kinds and types', () => {
    const s = z.object(schemas.remember);
    expect(
      s.safeParse({
        text: 'x',
        type: 'deployment',
        evidence: [
          { kind: 'tx', digest: 'd', network: 'sui:mainnet' },
          { kind: 'file', path: 'a.ts', commit: 'abc' },
        ],
      }).success,
    ).toBe(true);
    expect(s.safeParse({ text: 'x', type: 'nope' }).success).toBe(false);
    expect(s.safeParse({ text: 'x', type: 'fact', evidence: [{ kind: 'mystery' }] }).success).toBe(false);
    expect(s.safeParse({ text: '', type: 'fact' }).success).toBe(false);
    expect(
      z
        .object(schemas.rememberBulk)
        .safeParse({ items: Array.from({ length: 21 }, () => ({ text: 'x', type: 'fact' })) }).success,
    ).toBe(false);
  });
});
