import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeWorld, type World } from './http-helpers.js';

// Phase 9 E2: logs answer request counts, latency, error classes and per-project write volume later, without
// content. One JSON line per request (route pattern, never the URL) and one per queued write (project and event
// type, never text). Job runs are covered in packages/worker/test/job-log.test.ts.

const MARK = 'MEMORY-TEXT-MARKER-7731';
const requests: string[] = [];
const events: string[] = [];
let w: World;
let token = '';
let pid = '';

beforeAll(async () => {
  w = await makeWorld({ appConfig: { requestLog: (l: string) => void requests.push(l) } });
  w.stack.deps.eventLog = (l: string) => void events.push(l);
  const a = await w.signIn('observer@example.com');
  token = a.token;
  pid = (
    await w.req('POST', `/v1/workspaces/${a.workspaceId}/projects`, {
      token,
      body: { name: 'Observed', networks: ['sui:testnet'] },
    })
  ).json.data.id as string;
  await w.req('POST', `/v1/projects/${pid}/memories`, {
    token,
    body: { text: `Decision: ${MARK} stays out of logs.`, type: 'decision' },
  });
  await w.req('GET', `/v1/projects/${pid}/memories?q=${MARK}-query`, { token });
  await w.req('GET', `/v1/projects/prj_00000000000000000000000000/memories`, { token });
}, 60_000);
afterAll(() => w.close());

const parsed = (lines: string[]) => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

describe('request log', () => {
  it('one JSON line per request: route pattern, method, status, latency and project', () => {
    const post = parsed(requests).find((r) => r.method === 'POST' && r.route === '/v1/projects/:id/memories');
    expect(post).toMatchObject({ level: 'info', event: 'request', project: pid });
    expect(post!.status).toBeGreaterThanOrEqual(200);
    expect(post!.status).toBeLessThan(300);
    expect(typeof post!.ms).toBe('number');
    expect(typeof post!.requestId).toBe('string');
  });

  it('a failed request carries its error class, not its message', () => {
    const miss = parsed(requests).find(
      (r) => r.route === '/v1/projects/:id/memories' && (r.status as number) >= 400,
    );
    expect(miss).toBeDefined();
    expect(typeof miss!.error).toBe('string');
    expect(miss!).not.toHaveProperty('message');
  });

  it('never carries memory text, query strings, tokens or full URLs', () => {
    const all = requests.join('\n');
    expect(all).not.toContain(MARK);
    expect(all).not.toContain(token);
    expect(all).not.toContain('?q=');
    expect(all).not.toContain('http');
  });
});

describe('write log', () => {
  it('one line per queued write: project and event type, no text', () => {
    const writes = parsed(events).filter((e) => e.event === 'write_queued');
    expect(writes).toContainEqual(
      expect.objectContaining({ level: 'info', project: pid, evt: 'memory.created', actor: 'user' }),
    );
    expect(events.join('\n')).not.toContain(MARK);
  });
});
