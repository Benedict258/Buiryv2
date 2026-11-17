// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { RestBackend } from '../src/index.js';

// Phase 10 load run: the first call after a long idle period failed with "fetch failed". Reads are retried once
// after a network failure (no response); writes are not, and the cause is kept in the message.
const ok = (data: unknown) =>
  new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const networkError = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });

function flaky(failures: number) {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(String(url).split('/').pop()!);
    if (failures-- > 0) throw networkError();
    return ok({ briefing: 'b', memoryId: 'mem_1', results: [] });
  }) as unknown as typeof fetch;
  return { calls, f };
}

describe('RestBackend network failures', () => {
  it('retries a read once and succeeds', async () => {
    const { calls, f } = flaky(1);
    const b = new RestBackend({ baseUrl: 'http://x', token: 't', fetch: f });
    await expect(b.check({ task: 't' } as never)).resolves.toBeTruthy();
    expect(calls).toEqual(['check', 'check']);
  });

  it('does not retry a write, and names the cause', async () => {
    const { calls, f } = flaky(1);
    const b = new RestBackend({ baseUrl: 'http://x', token: 't', fetch: f });
    const e = await b.remember({ text: 'x', type: 'fact' } as never).catch((x: Error) => x);
    expect((e as Error).message).toContain('fetch failed: ECONNRESET');
    expect(calls).toEqual(['remember']);
  });

  it('gives up after one retry', async () => {
    const { calls, f } = flaky(5);
    const b = new RestBackend({ baseUrl: 'http://x', token: 't', fetch: f });
    await expect(b.recall({ query: 'q' } as never)).rejects.toThrow('unreachable');
    expect(calls).toEqual(['recall', 'recall']);
  });
});
