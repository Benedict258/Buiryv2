import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { toolError } from '@buiry/mcp';
import { Ed25519Signer, HttpWalrusAdapter, RelayerError, writeErrorText } from '@buiry/storage';
import {
  createWebhook,
  deliverDue,
  listDeliveries,
  queueRenewals,
  testWebhook,
  type UserPrincipal,
} from '../src/index.js';
import { Clock, createDrain, createStack, startRelayer, type Stack } from './helpers.js';

// Phase 5.4, error-text sweep: each test triggers the real error and checks that no raw text (which can carry stored
// values, hosts, user names or keys) reaches the agent, the Storage page, the delivery log or the logs.

const LEAK = 'SECRET-raw-text-10.9.8.7-do-not-leak';
const lines: string[] = [];
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation(
    (...a: unknown[]) => void lines.push(a.map(String).join(' ')),
  );
});
afterAll(() => vi.restoreAllMocks());

const pgError = () => Object.assign(new Error(`duplicate key value (text)=(${LEAK})`), { code: '23505' });

describe('A2: MCP tool errors', () => {
  it('answers internal with a generic message and logs class and code only', () => {
    lines.length = 0;
    const r = toolError(pgError());
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).not.toContain(LEAK);
    expect((r.content[0] as { text: string }).text).toBe('internal: internal error');
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { level: 'error', event: 'tool_error', error: 'Error', code: '23505' },
    ]);
  });
});

async function writeOne(stack: Stack) {
  const ws = await stack.newWorkspace('Errors');
  const pj = await stack.newProject(ws.id, 'errors');
  const agent = await stack.newAgent({
    workspaceId: ws.id,
    projectId: pj.id,
    name: 'a',
    tool: 'claude-code',
    permissions: ['read', 'write'],
  });
  await agent.backend.remember({ text: 'A decision worth storing.', type: 'decision' });
  return { ws, pj };
}
const lastErrors = async (stack: Stack) =>
  (
    await stack.db.system((tx) =>
      tx.query<{ last_error: string | null }>('select last_error from write_jobs'),
    )
  ).rows.map((r) => r.last_error);

describe('A3 and A12: write queue errors on the Storage page', () => {
  it('records a stable code and message, not the relayer text (A3)', async () => {
    const clock = new Clock();
    const { mock, adapter } = await startRelayer(clock);
    const stack = await createStack({ now: clock.now, adapter });
    await writeOne(stack);
    mock.failNextWrites(1, 400, `bad signature for key ${LEAK} at https://relayer.internal/v1`);
    await createDrain(stack.deps, adapter, { pollIntervalMs: 0 }).tick();
    const errs = await lastErrors(stack);
    expect(errs).toEqual(['client: the storage relayer rejected the request (HTTP 400)']);
    await stack.close();
    await mock.close();
  }, 60_000);

  it('reports an unreachable relayer without the exception text or address (A12)', async () => {
    // The drain checks relayer health first and skips writes while it is unreachable, so the error is taken from the
    // adapter call that write jobs make; its text then goes through writeErrorText into last_error.
    const adapter = new HttpWalrusAdapter({
      baseUrl: 'http://127.0.0.1:1',
      accountId: '0xacct',
      signer: new Ed25519Signer('44'.repeat(32)),
    });
    const err = (await adapter
      .remember('buiry.v1.prj_x.main', 'text')
      .catch((e: unknown) => e)) as RelayerError;
    expect(err).toBeInstanceOf(RelayerError);
    expect(err.message).not.toMatch(/fetch failed|127\.0\.0\.1/);
    expect(writeErrorText(err)).toBe('unavailable: the storage relayer was unreachable or unavailable');
  }, 60_000);
});

describe('A4: webhook delivery errors', () => {
  it('records a stable code and message chosen from the error code', async () => {
    const stack = await createStack({});
    const ws = await stack.newWorkspace('Hooks');
    const owner: UserPrincipal = {
      kind: 'user',
      workspaceId: ws.id,
      userId: 'usr_o',
      displayName: 'O',
      role: 'owner',
      projectScope: null,
    };
    const resolve = async () => ['93.184.216.34'];
    const hook = await stack.db.tenant(ws.id, (tx) =>
      createWebhook(
        stack.deps,
        tx,
        owner,
        { name: 'h', kind: 'generic', url: 'https://hooks.example.test/x', events: ['*'] },
        { resolve },
      ),
    );
    await stack.db.tenant(ws.id, (tx) => testWebhook(stack.deps, tx, owner, hook.id));
    const send = async () => {
      throw Object.assign(new Error(`connect ECONNREFUSED 10.9.8.7:443 ${LEAK}`), { code: 'ECONNREFUSED' });
    };
    await deliverDue(stack.deps, { resolve, send });
    const rows = await stack.db.tenant(ws.id, (tx) => listDeliveries(tx, owner, hook.id));
    expect(rows.map((r) => r.last_error)).toEqual([
      'connection_refused: the endpoint refused the connection',
    ]);
    await stack.close();
  }, 60_000);
});

describe('A5: renewal queue errors', () => {
  it('gives a stable reason and logs class and code only', async () => {
    const stack = await createStack({});
    lines.length = 0;
    const deps = { ...stack.deps, db: { ...stack.deps.db, system: () => Promise.reject(pgError()) } };
    const out = await queueRenewals(deps, ['mem_x']);
    expect(out.failed).toEqual([{ memoryId: 'mem_x', reason: 'internal error' }]);
    expect(lines.join('\n')).not.toContain(LEAK);
    expect(lines.map((l) => JSON.parse(l))).toContainEqual({
      level: 'error',
      event: 'renewal_error',
      error: 'Error',
      code: '23505',
    });
    await stack.close();
  }, 60_000);
});
