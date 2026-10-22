import { createHash, createHmac, randomBytes } from 'node:crypto';
import { BuiryError, newId, type Evidence, type IdPrefix, type MemoryType, type Status } from '@buiry/core';
import type { Tx } from '../db/db.js';
import type { IndexedMemory } from '@buiry/storage';
import type { Principal, ServiceDeps } from './types.js';

export const cryptoRandom = (n: number): Uint8Array => new Uint8Array(randomBytes(n));

export const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
export const hmac = (secret: string, s: string): string =>
  createHmac('sha256', secret).update(s).digest('hex');

export const genId = (d: Pick<ServiceDeps, 'now' | 'random'>, prefix: IdPrefix): string =>
  newId(prefix, d.now(), d.random);

export const iso = (ms: number | null | undefined): string | undefined =>
  ms === null || ms === undefined ? undefined : new Date(ms).toISOString();

export type Row = Record<string, unknown>;

export interface MemoryRow extends Row {
  id: string;
  workspace_id: string;
  project_id: string;
  branch_id: string;
  branch_slug: string;
  type: MemoryType;
  status: Status;
  text: string;
  confidence: number;
  agent_slug: string;
  agent_id: string | null;
  actor_kind: string;
  session_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  last_reinforced_at: Date | string;
  supersedes_id: string | null;
  superseded_by_id: string | null;
  ref_memory_id: string | null;
  walrus_blob_id: string | null;
  write_state: 'queued' | 'stored' | 'failed';
  end_epoch: number | null;
  expires_at: Date | string | null;
  expired: boolean;
  flags: string[];
  learning: Record<string, unknown>;
  seq: number;
}

const ms = (v: Date | string): number => (v instanceof Date ? v.getTime() : Date.parse(v));

export async function evidenceFor(tx: Tx, memoryIds: string[]): Promise<Map<string, Evidence[]>> {
  const out = new Map<string, Evidence[]>();
  if (memoryIds.length === 0) return out;
  const r = await tx.query<{ memory_id: string; ref: Evidence }>(
    'select memory_id, ref from evidence where memory_id = any($1) order by id',
    [memoryIds],
  );
  for (const row of r.rows) out.set(row.memory_id, [...(out.get(row.memory_id) ?? []), row.ref]);
  return out;
}

export function toRecord(r: MemoryRow, evidence: Evidence[]): IndexedMemory {
  const rec: IndexedMemory = {
    id: r.id,
    branch: r.branch_slug,
    type: r.type,
    status: r.status,
    text: r.text,
    confidence: Number(r.confidence),
    agent: r.agent_slug,
    createdAt: ms(r.created_at),
    updatedAt: ms(r.updated_at),
    lastReinforcedAt: ms(r.last_reinforced_at),
    evidence,
    writeState: r.write_state,
    flags: r.flags ?? [],
    expired: r.expired,
  };
  if (r.supersedes_id) rec.supersedesId = r.supersedes_id;
  if (r.superseded_by_id) rec.supersededById = r.superseded_by_id;
  if (r.walrus_blob_id) rec.blobId = r.walrus_blob_id;
  if (r.expires_at) rec.expiresAt = ms(r.expires_at);
  return rec;
}

export async function loadMemories(tx: Tx, rows: MemoryRow[]): Promise<IndexedMemory[]> {
  const ev = await evidenceFor(
    tx,
    rows.map((r) => r.id),
  );
  return rows.map((r) => toRecord(r, ev.get(r.id) ?? []));
}

export interface ActivityInput {
  workspaceId: string;
  projectId?: string;
  actor: { kind: 'agent' | 'user' | 'system'; id?: string };
  operation: string;
  target?: Record<string, unknown>;
  result: 'success' | 'error' | 'queued';
  latencyMs?: number;
  detail?: Record<string, unknown>;
  requestId?: string;
}

export async function logActivity(
  tx: Tx,
  d: Pick<ServiceDeps, 'now' | 'random'>,
  a: ActivityInput,
): Promise<string> {
  const id = genId(d, 'evt');
  await tx.query(
    `insert into activity_log (id, workspace_id, project_id, actor_kind, actor_id, operation, target, result, latency_ms, request_id, detail, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      id,
      a.workspaceId,
      a.projectId ?? null,
      a.actor.kind,
      a.actor.id ?? null,
      a.operation,
      JSON.stringify(a.target ?? {}),
      a.result,
      a.latencyMs ?? null,
      a.requestId ?? null,
      JSON.stringify(a.detail ?? {}),
      new Date(d.now()),
    ],
  );
  return id;
}

export function actorOf(p: Principal): ActivityInput['actor'] {
  return p.kind === 'agent' ? { kind: 'agent', id: p.agentSlug } : { kind: 'user', id: p.userId };
}

export function notFound(what: string): BuiryError {
  return new BuiryError('not_found', `${what} not found in this project`);
}
