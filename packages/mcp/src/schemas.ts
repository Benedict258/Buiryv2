// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { MEMORY_TYPES, STATUSES } from '@buiry/core';

export const evidenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tx'), digest: z.string().min(1), network: z.string().min(1) }),
  z.object({
    kind: z.literal('object'),
    id: z.string().min(1),
    version: z.string().optional(),
    network: z.string().min(1),
  }),
  z.object({ kind: z.literal('package'), id: z.string().min(1), network: z.string().min(1) }),
  z.object({ kind: z.literal('file'), path: z.string().min(1), commit: z.string().optional() }),
  z.object({ kind: z.literal('url'), href: z.string().min(1) }),
  z.object({ kind: z.literal('test'), name: z.string().min(1), result: z.enum(['pass', 'fail']) }),
]);

const memoryType = z.enum(MEMORY_TYPES);
const status = z.enum(STATUSES);

export const relationSchema = z.object({
  kind: z.enum(['supersedes', 'distinct', 'agrees']),
  memoryId: z.string(),
});

export const rememberShape = {
  text: z
    .string()
    .min(1)
    .describe(
      'One self-contained statement. Prefer a summary and a reference over pasted code or logs. Never include secrets.',
    ),
  type: memoryType.describe(
    'decision | constraint | fact | failure | procedure | preference | task_state | deployment | handoff',
  ),
  evidence: z
    .array(evidenceSchema)
    .max(8)
    .optional()
    .describe(
      'Checkable references: transaction digest, object id and version, package id, file path with commit, url, test result.',
    ),
  branch: z.string().optional().describe('Branch to write to. Defaults to the active branch.'),
  relation: relationSchema
    .optional()
    .describe('If a conflict candidate was returned, declare how this memory relates to it.'),
  idempotencyKey: z.string().max(200).optional(),
};

export const schemas = {
  connect: {
    project: z.string().optional().describe('Project id from BUIRY.md'),
    branch: z.string().optional(),
    client: z.string().optional(),
  },
  check: {
    task: z
      .string()
      .optional()
      .describe('One or two sentences describing what you are about to do; used to rank the briefing.'),
    tokenBudget: z.number().int().min(200).max(8000).optional(),
    branch: z.string().optional(),
  },
  remember: rememberShape,
  rememberBulk: { items: z.array(z.object(rememberShape)).min(1).max(20) },
  recall: {
    query: z.string().min(1),
    type: memoryType.optional(),
    status: z.array(status).optional(),
    branch: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  },
  report: {
    memoryId: z.string(),
    outcome: z.enum(['helped', 'wrong', 'irrelevant', 'outdated']),
    note: z.string().max(500).optional(),
  },
  resolve: {
    memoryId: z.string(),
    action: z.enum(['confirm', 'contest', 'supersede', 'tombstone']),
    reason: z.string().max(500).optional(),
    supersededBy: z.string().optional(),
  },
  handoff: {
    done: z.array(z.string()),
    blocked: z.array(z.string()),
    next: z.array(z.string()),
    reliedOn: z.array(z.string()).optional(),
    notes: z.string().max(2000).optional(),
    branch: z.string().optional(),
  },
  verify: { memoryId: z.string().optional(), evidence: evidenceSchema.optional() },
  chainRead: {
    kind: z.enum(['transaction', 'object', 'package_versions', 'epoch']),
    identifier: z.string().optional(),
    network: z.string().optional(),
  },
  chainSimulate: {
    transactionBcsBase64: z.string().min(1).describe('BCS-encoded TransactionData, base64'),
    network: z.string().optional(),
    label: z.string().max(120).optional(),
    createFailureMemory: z
      .boolean()
      .optional()
      .describe('Store a failed simulation as a proposed failure memory'),
    branch: z.string().optional(),
  },
  branch: {
    action: z.enum(['list', 'create', 'switch', 'propose_merge']),
    name: z.string().optional(),
    from: z.string().optional(),
    into: z.string().optional(),
  },
};
