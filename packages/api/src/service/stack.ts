import { randomBytes } from 'node:crypto';
import { PgliteDb, type Db } from '../db/db.js';
import { createAgent, createProject, createWorkspace, type NewAgent } from './admin.js';
import { authenticateAgentToken } from './auth.js';
import { AgentBackend, AgentRateLimiter, MemoryService } from './memory-service.js';
import type { ServiceDeps } from './types.js';

export interface StackOptions extends Partial<Omit<ServiceDeps, 'db'>> {
  db?: Db;
  agentCallsPerMinute?: number;
}

/** Everything needed to run the product in-process: Postgres (PGlite), service, auth. */
export async function createStack(o: StackOptions = {}) {
  const db = o.db ?? (await PgliteDb.create());
  const clockNow = o.now ?? Date.now;
  const deps: ServiceDeps = {
    db,
    now: clockNow,
    random: o.random ?? ((n) => new Uint8Array(randomBytes(n))),
    secretKey: o.secretKey ?? 'test-secret-key-test-secret-key-0000',
    ...(o.learning ? { learning: o.learning } : {}),
    ...(o.adapter ? { adapter: o.adapter } : {}),
    ...(o.budgets ? { budgets: o.budgets } : {}),
    ...(o.gateway ? { gateway: o.gateway } : {}),
    ...(o.storage ? { storage: o.storage } : {}),
    ...(o.renewalEnabled ? { renewalEnabled: true } : {}),
    ...(o.agentTokenMaxDays ? { agentTokenMaxDays: o.agentTokenMaxDays } : {}),
    ...(o.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: o.verifyTimeoutMs } : {}),
    ...(o.maxTextLength !== undefined ? { maxTextLength: o.maxTextLength } : {}),
    ...(o.reverifyAfterMs !== undefined ? { reverifyAfterMs: o.reverifyAfterMs } : {}),
    ...(o.checkReverifyBudgetMs !== undefined ? { checkReverifyBudgetMs: o.checkReverifyBudgetMs } : {}),
  };
  const service = new MemoryService(deps);
  const limiter = new AgentRateLimiter(o.agentCallsPerMinute ?? 600, deps.now);

  /** Authenticate a token and return the agent's backend (what MCP/REST hand to a tool call). */
  const backendFor = async (token: string, sessionId?: string) =>
    new AgentBackend(service, await authenticateAgentToken(deps, token, sessionId), limiter);

  const newWorkspace = (name = 'Northwind Labs') => createWorkspace(deps, name);
  const newProject = (
    workspaceId: string,
    name = 'orbit-api',
    extra: Partial<Parameters<typeof createProject>[1]> = {},
  ) => createProject(deps, { workspaceId, name, networks: ['sui:mainnet'], ...extra });
  const newAgent = async (a: NewAgent) => {
    const made = await createAgent(deps, a);
    return { ...made, backend: await backendFor(made.token) };
  };
  return {
    db,
    deps,
    service,
    limiter,
    backendFor,
    newWorkspace,
    newProject,
    newAgent,
    close: () => db.close(),
  };
}

export type Stack = Awaited<ReturnType<typeof createStack>>;
