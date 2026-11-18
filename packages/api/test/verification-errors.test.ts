import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TatumGateway } from '@buiry/chain';
import { makeWorld, type World } from './http-helpers.js';

// Phase 2.1 (SECURITY_REVIEW sweep A1): an unexpected error during a chain read used to be wrapped as
// BuiryError('internal', <raw message>), returned to the client verbatim and never logged. It must get the stable
// `internal` code with a generic message, and one M5 log line without the message.

const LEAK = 'SECRET-row-value-do-not-leak';
let w: World;
const lines: string[] = [];
beforeAll(async () => {
  // A gateway whose read fails with something other than a ChainError, like a database or programming error.
  const gateway = {
    defaultNetwork: 'sui:mainnet',
    listPackageVersions: () =>
      Promise.reject(Object.assign(new Error(`duplicate key value (text)=(${LEAK})`), { code: '23505' })),
  } as unknown as TatumGateway;
  w = await makeWorld({ stackOpts: { gateway } });
  vi.spyOn(console, 'error').mockImplementation(
    (...a: unknown[]) => void lines.push(a.map(String).join(' ')),
  );
}, 60_000);
afterAll(async () => {
  vi.restoreAllMocks();
  await w.close();
});

describe('chain read errors', () => {
  it('answers with a stable code and logs the class and Postgres code, never the raw message', async () => {
    const a = await w.signIn('verify-errors@example.com');
    const project = await w.req('POST', `/v1/workspaces/${a.workspaceId}/projects`, {
      token: a.token,
      body: { name: 'errors', networks: ['sui:mainnet'] },
    });
    const agent = await w.req('POST', `/v1/projects/${project.json.data.id}/agents`, {
      token: a.token,
      body: { name: 'claude', tool: 'claude-code', permissions: ['read'] },
    });
    lines.length = 0;
    const res = await w.req('POST', '/v1/agent/chain_read', {
      token: agent.json.data.token,
      body: { kind: 'package_versions', identifier: '0x2' },
    });

    expect(res.status).toBe(500);
    expect(res.json.error).toMatchObject({ code: 'internal', message: 'internal error' });
    expect(JSON.stringify(res.json)).not.toContain(LEAK);
    const logged = lines.filter((l) => l.includes('server_error'));
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]!)).toMatchObject({
      event: 'server_error',
      route: '/v1/agent/chain_read',
      error: 'Error',
      code: '23505',
    });
    expect(lines.join('\n')).not.toContain(LEAK);
  });
});
