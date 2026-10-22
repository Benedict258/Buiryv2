import { z } from 'zod';
import { BuiryError, type BranchInput } from '@buiry/core';
import { schemas } from '@buiry/mcp';
import { AgentBackend } from '../service/memory-service.js';
import { agentBackendFor, bearer, body, ok, parse, type Registrar } from './context.js';

const memoryItem = z.object(schemas.remember);

/**
 * The agent surface used by the MCP server (`RestBackend`): the token fixes the tenant and project, so
 * no request field can name another one.
 */
export const registerAgent: Registrar = (_app, ctx, r) => {
  const ops: Record<string, (b: AgentBackend, input: Record<string, unknown>) => Promise<unknown>> = {
    connect: (b, i) => b.connect(parse(z.object(schemas.connect), i)),
    check: (b, i) => b.check(parse(z.object(schemas.check), i)),
    remember: (b, i) => b.remember(parse(memoryItem, i)),
    remember_bulk: (b, i) => b.rememberBulk(parse(z.object(schemas.rememberBulk), i).items),
    recall: (b, i) => b.recall(parse(z.object(schemas.recall), i)),
    report: (b, i) => b.report(parse(z.object(schemas.report), i)),
    resolve: (b, i) => b.resolve(parse(z.object(schemas.resolve), i)),
    handoff: (b, i) => b.handoff(parse(z.object(schemas.handoff), i)),
    verify: (b, i) => b.verify(parse(z.object(schemas.verify), i)),
    chain_read: (b, i) => b.chainRead(parse(z.object(schemas.chainRead), i)),
    chain_simulate: (b, i) => b.chainSimulate(parse(z.object(schemas.chainSimulate), i)),
    branch: (b, i) => {
      const v = parse(z.object(schemas.branch), i);
      if (v.action !== 'list' && !v.name) throw new BuiryError('invalid_input', 'name is required');
      return b.branch((v.action === 'list' ? { action: 'list' } : v) as BranchInput);
    },
    status: (b) => b.status(),
    memory: (b, i) => b.getMemory(parse(z.object({ memoryId: z.string() }), i).memoryId),
    briefing: (b, i) => b.getBriefing(parse(z.object({ branch: z.string().optional() }), i).branch),
    project: (b) => b.getProject(),
  };
  for (const [op, run] of Object.entries(ops)) {
    r({ method: 'POST', path: `/v1/agent/${op}`, auth: 'agent', scope: 'none' }, async (c) => {
      const token = bearer(c);
      if (!token) throw new BuiryError('unauthorized', 'agent token required');
      const principal = await agentBackendFor(ctx, token, c.req.header('x-buiry-session'));
      const backend = new AgentBackend(ctx.service, principal, ctx.limiter);
      return ok(c, await run(backend, (await body(c)) as Record<string, unknown>));
    });
  }
};
