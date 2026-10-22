/** Sample content from the UI spec (section 12), used by the dashboard seed and the demo. All identifiers are fictitious. */
import type { Stack } from '../../packages/api/src/index.js';
import type { AgentBackend } from '../../packages/api/src/index.js';

export interface Seeded {
  workspaceId: string;
  projectId: string;
  agents: { claude: Agent; opencode: Agent; cursor: Agent };
  memoryIds: Record<string, string>;
}
interface Agent {
  agentId: string;
  slug: string;
  token: string;
  backend: AgentBackend;
}

export async function seedOrbitApi(
  stack: Stack,
  opts: { workspaceName?: string; networks?: string[] } = {},
): Promise<Seeded> {
  const ws = await stack.newWorkspace(opts.workspaceName ?? 'Northwind Labs');
  const prj = await stack.newProject(ws.id, 'orbit-api', {
    networks: opts.networks ?? ['sui:mainnet', 'sui:testnet'],
  });
  const mk = (name: string, tool: string) =>
    stack.newAgent({ workspaceId: ws.id, projectId: prj.id, name, tool });
  const claude = await mk('claude-code', 'claude-code');
  const opencode = await mk('opencode', 'opencode');
  const cursor = await mk('cursor', 'cursor');
  const memoryIds: Record<string, string> = {};
  const w = async (
    key: string,
    a: Agent,
    text: string,
    type: Parameters<AgentBackend['remember']>[0]['type'],
    evidence?: Parameters<AgentBackend['remember']>[0]['evidence'],
  ) => {
    memoryIds[key] = (await a.backend.remember({ text, type, ...(evidence ? { evidence } : {}) })).memoryId;
  };
  await w('pnpm', claude, 'Use pnpm workspaces; npm hoisting broke the build in packages/api.', 'decision', [
    { kind: 'file', path: 'packages/api/package.json', commit: 'a1b2c3d' },
  ]);
  await w(
    'internal',
    opencode,
    'Never import from internal/ in app code; use the public barrel files.',
    'constraint',
  );
  await w(
    'gas',
    cursor,
    'Running the migration in one transaction exceeded the gas limit; split it into batches of 200 rows.',
    'failure',
    [{ kind: 'test', name: 'migrate-batch', result: 'fail' }],
  );
  await w(
    'release',
    claude,
    'Release: run tests, bump version, tag, publish the package, then update the registry.',
    'procedure',
  );
  await w('prs', claude, 'Prefer small pull requests under 300 lines; strict TypeScript.', 'preference');
  await w(
    'staging',
    cursor,
    'The staging API uses the testnet network and the rate limit is 100 requests per minute.',
    'fact',
    [{ kind: 'url', href: 'https://example.com/docs/staging' }],
  );
  await w(
    'auth',
    opencode,
    'Auth refactor is about 70% done; refresh-token tests are pending.',
    'task_state',
    [{ kind: 'file', path: 'src/auth/refresh.ts', commit: '5d9e0aa' }],
  );
  await w('sessionsDb', claude, 'Store sessions in the database.', 'decision');
  await w('sessionsRedis', cursor, 'Store sessions in Redis.', 'decision');
  return { workspaceId: ws.id, projectId: prj.id, agents: { claude, opencode, cursor }, memoryIds };
}
