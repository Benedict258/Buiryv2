import { BuiryError, errorTag } from '@buiry/core';
import {
  authenticateAgentToken,
  createAgent,
  createProject,
  genId,
  issueAgentToken,
  raiseFlag,
  revokeAgent,
  AgentBackend,
  MemoryService,
  type ServiceDeps,
} from '@buiry/api';

export interface CanaryReport {
  ok: boolean;
  attempts: number;
  violations: string[];
}

async function ensureCanary(deps: ServiceDeps) {
  const found = await deps.db.system((tx) =>
    tx.query<{ id: string }>(`select id from workspaces where name = 'buiry-isolation-canary'`),
  );
  let workspaceId = found.rows[0]?.id;
  if (!workspaceId) {
    workspaceId = genId(deps, 'wsp');
    await deps.db.system((tx) =>
      tx.query(`insert into workspaces (id, name, plan) values ($1,'buiry-isolation-canary','internal')`, [
        workspaceId,
      ]),
    );
  }
  const projects = await deps.db.tenant(workspaceId, (tx) =>
    tx.query<{ id: string; name: string }>('select id, name from projects order by name'),
  );
  const ids: Record<string, string> = Object.fromEntries(projects.rows.map((r) => [r.name, r.id]));
  for (const name of ['canary-a', 'canary-b']) {
    if (!ids[name])
      ids[name] = (
        await createProject(deps, { workspaceId, name, networks: [`sui:${deps.networks?.sui ?? 'mainnet'}`] })
      ).id;
  }
  return { workspaceId, a: ids['canary-a']!, b: ids['canary-b']! };
}

/**
 * Synthetic job: with a token for canary project A, try to reach canary project B through every path
 * (memory id, branch name, recall, tenant SQL). Any success is a critical alert and an audit record.
 */
export async function isolationCanary(deps: ServiceDeps): Promise<CanaryReport> {
  const c = await ensureCanary(deps);
  const mk = async (projectId: string, name: string) => {
    const agents = await deps.db.tenant(c.workspaceId, (tx) =>
      tx.query<{ id: string }>('select id from agents where project_id = $1 and revoked_at is null limit 1', [
        projectId,
      ]),
    );
    const agentId =
      agents.rows[0]?.id ??
      (await createAgent(deps, { workspaceId: c.workspaceId, projectId, name, tool: 'canary' })).agentId;
    const token = await issueAgentToken(deps, c.workspaceId, agentId);
    const principal = await authenticateAgentToken(deps, token);
    return { agentId, backend: new AgentBackend(new MemoryService(deps), principal) };
  };
  const a = await mk(c.a, 'canary-a');
  const b = await mk(c.b, 'canary-b');
  const secretMarker = `canary-secret-${genId(deps, 'evt')}`;
  const planted = await b.backend
    .remember({ text: `Canary ${secretMarker} belongs only to project B.`, type: 'fact' })
    .catch(() => null);
  const violations: string[] = [];
  let attempts = 0;
  const mustFail = async (label: string, fn: () => Promise<unknown>) => {
    attempts++;
    try {
      const r = await fn();
      if (JSON.stringify(r ?? '').includes(secretMarker) || (r && !(r as { results?: unknown[] }).results))
        violations.push(`${label}: succeeded`);
    } catch (e) {
      if (!(e instanceof BuiryError))
        violations.push(`${label}: unexpected error ${JSON.stringify(errorTag(e))}`);
    }
  };
  if (planted) {
    await mustFail('getMemory(B id)', () => a.backend.getMemory(planted.memoryId));
    await mustFail('report(B id)', () => a.backend.report({ memoryId: planted.memoryId, outcome: 'helped' }));
    await mustFail('resolve(B id)', () =>
      a.backend.resolve({ memoryId: planted.memoryId, action: 'tombstone' }),
    );
    await mustFail('relation(B id)', () =>
      a.backend.remember({
        text: 'Probe relation',
        type: 'fact',
        relation: { kind: 'supersedes', memoryId: planted.memoryId },
      }),
    );
    attempts++;
    const rec = await a.backend.recall({ query: secretMarker }).catch(() => null);
    if (rec && JSON.stringify(rec).includes(secretMarker)) violations.push('recall: leaked B memory');
  }
  await mustFail('connect(B project)', () => a.backend.connect({ project: c.b }));
  await mustFail('branch switch', () => a.backend.branch({ action: 'switch', name: 'only-in-b' }));
  attempts++;
  // RLS is by workspace: from inside the canary workspace, another workspace's rows must be invisible.
  const other = await deps.db.system((tx) =>
    tx.query<{ id: string }>(`select id from workspaces where id <> $1 limit 1`, [c.workspaceId]),
  );
  const rls = other.rows[0]
    ? await deps.db.tenant(
        c.workspaceId,
        async (tx) =>
          (await tx.query('select 1 from projects where workspace_id = $1', [other.rows[0]!.id])).rows.length,
      )
    : 0;
  if (rls > 0) violations.push('tenant sql: another workspace is visible');
  await revokeAgent(deps, c.workspaceId, a.agentId).catch(() => {});
  await revokeAgent(deps, c.workspaceId, b.agentId).catch(() => {});
  if (violations.length) {
    await deps.db.system(async (tx) => {
      await tx.query(
        `insert into audit_log (id, workspace_id, actor, action, detail) values ($1,$2,'canary','canary.violation',$3)`,
        [genId(deps, 'evt'), c.workspaceId, JSON.stringify({ violations })],
      );
    });
    await deps.db.tenant(c.workspaceId, (tx) =>
      raiseFlag(deps, tx, {
        workspaceId: c.workspaceId,
        projectId: c.a,
        kind: 'verification',
        severity: 'critical',
        detail: `ISOLATION CANARY FAILED: ${violations.join('; ')}`,
      }),
    );
  }
  return { ok: violations.length === 0, attempts, violations };
}
