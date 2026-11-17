import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  BuiryError,
  DEFAULT_LEARNING,
  newId,
  type Evidence,
  type LearningConfig,
  type IdPrefix,
  type MemoryType,
  type Status,
} from '@buiry/core';
import type { Tx } from '../db/db.js';
import type { IndexedMemory } from '@buiry/storage';
import type { Principal, ServiceDeps } from './types.js';

export const cryptoRandom = (n: number): Uint8Array => new Uint8Array(randomBytes(n));

export const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
export const hmac = (secret: string, s: string): string =>
  createHmac('sha256', secret).update(s).digest('hex');

/**
 * Hashes of a token to look up: under the current key and, during a BUIRY_SECRET_KEY rotation, the previous key.
 * The first entry is always the current-key hash.
 */
export const tokenHashes = (
  d: Pick<ServiceDeps, 'secretKey' | 'previousSecretKey'>,
  token: string,
): string[] =>
  d.previousSecretKey
    ? [hmac(d.secretKey, token), hmac(d.previousSecretKey, token)]
    : [hmac(d.secretKey, token)];

/** After a lookup matched a previous-key hash, store the current-key hash so the token keeps working afterwards. */
export async function upgradeTokenHash(
  tx: { query: (q: string, p?: unknown[]) => Promise<unknown> },
  d: Pick<ServiceDeps, 'secretKey'>,
  table: 'sessions' | 'agent_tokens' | 'api_tokens',
  id: string,
  storedHash: string,
  token: string,
): Promise<void> {
  const current = hmac(d.secretKey, token);
  if (storedHash !== current)
    await tx.query(`update ${table} set token_hash = $1 where id = $2`, [current, id]);
}

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

const finite = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined;

/**
 * The learning configuration for one project: the service default overlaid with the project's saved
 * settings (auto-promotion, per-type half-lives, review threshold). Invalid values are ignored, so a bad
 * setting can never break scoring.
 */
export function learningFor(
  deps: ServiceDeps,
  settings: Record<string, unknown> | undefined,
): LearningConfig {
  const base = deps.learning ?? DEFAULT_LEARNING;
  if (!settings) return base;
  const out: LearningConfig = {
    ...base,
    promotion: { ...base.promotion },
    halfLifeDays: { ...base.halfLifeDays },
  };
  const ap = settings.autoPromotion as Record<string, unknown> | undefined;
  if (ap && typeof ap === 'object') {
    if (typeof ap.enabled === 'boolean') out.promotion.enabled = ap.enabled;
    const hr = finite(ap.helpfulReports, 1, 50);
    if (hr !== undefined) out.promotion.helpfulReports = Math.round(hr);
    const ds = finite(ap.distinctSessions, 1, 50);
    if (ds !== undefined) out.promotion.distinctSessions = Math.round(ds);
  }
  const hl = settings.halfLives as Record<string, unknown> | undefined;
  if (hl && typeof hl === 'object') {
    for (const [type, v] of Object.entries(hl)) {
      const d = finite(v, 1, 3650);
      if (d !== undefined && type in out.halfLifeDays) (out.halfLifeDays as Record<string, number>)[type] = d;
    }
  }
  const rt = finite(settings.reviewThreshold, 0, 1);
  if (rt !== undefined) out.reviewThreshold = rt;
  return out;
}
