import { createHash, createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { BuiryError } from '@buiry/core';
import type { Tx } from '../db/db.js';
import type { ServiceDeps } from './types.js';
import { genId } from './util.js';

export const WEBHOOK_EVENTS = [
  'flag.created',
  'flag.resolved',
  'memory.stale',
  'memory.contested',
  'memory.expiring',
  'memory.created',
  'write.failed',
  'relayer.degraded',
  'verification.degraded',
  'handoff.created',
  'branch.merged',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

interface HookRow {
  id: string;
  kind: 'slack' | 'discord' | 'generic';
  events: string[];
  project_id: string | null;
}
interface RuleRow {
  event: string;
  min_severity: string;
  channel: string;
  webhook_id: string | null;
  quiet_hours: { startHour: number; endHour: number } | null;
  grouping: boolean;
  enabled: boolean;
}

const SEV = { info: 0, warning: 1, critical: 2 } as const;
export type Severity = keyof typeof SEV;

function inQuietHours(q: RuleRow['quiet_hours'], nowMs: number): { quiet: boolean; endsAt?: number } {
  if (!q) return { quiet: false };
  const d = new Date(nowMs);
  const h = d.getUTCHours();
  const quiet =
    q.startHour <= q.endHour ? h >= q.startHour && h < q.endHour : h >= q.startHour || h < q.endHour;
  if (!quiet) return { quiet: false };
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), q.endHour));
  if (end.getTime() <= nowMs) end.setUTCDate(end.getUTCDate() + 1);
  return { quiet: true, endsAt: end.getTime() };
}

/**
 * Fan an event out to matching webhooks (and alert rules). Dashboard visibility comes from flags and the
 * activity log; this only creates pending signed deliveries, which the worker sends.
 */
export async function publishEvent(
  deps: Pick<ServiceDeps, 'now' | 'random'>,
  tx: Tx,
  e: {
    workspaceId: string;
    projectId: string;
    type: WebhookEvent;
    severity?: Severity;
    data: Record<string, unknown>;
  },
): Promise<number> {
  const hooks = await tx.query<HookRow>(
    `select id, kind, events, project_id from webhooks where status = 'active' and (project_id is null or project_id = $1)`,
    [e.projectId],
  );
  const rules = await tx.query<RuleRow>(
    `select event, min_severity, channel, webhook_id, quiet_hours, grouping, enabled from alert_rules where project_id = $1 and event = $2 and enabled`,
    [e.projectId, e.type],
  );
  const sev = e.severity ?? 'info';
  let n = 0;
  const now = deps.now();
  for (const h of hooks.rows) {
    const rule = rules.rows.find((r) => r.webhook_id === h.id || (r.channel === 'webhook' && !r.webhook_id));
    const subscribed = h.events.includes(e.type) || h.events.includes('*');
    if (!subscribed && !rule) continue;
    if (rule && SEV[sev] < SEV[rule.min_severity as Severity]) continue;
    let when = now;
    if (rule) {
      const q = inQuietHours(rule.quiet_hours, now);
      if (q.quiet && sev !== 'critical') when = q.endsAt!;
      if (rule.grouping) {
        const dup = await tx.query(
          `select 1 from webhook_deliveries where webhook_id = $1 and event_type = $2 and payload->'data'->>'memoryId' is not distinct from $3 and created_at > $4 and state = 'pending' limit 1`,
          [h.id, e.type, (e.data.memoryId as string | undefined) ?? null, new Date(now - 10 * 60_000)],
        );
        if (dup.rows.length) continue;
      }
    }
    const id = genId(deps, 'evt');
    await tx.query(
      `insert into webhook_deliveries (id, workspace_id, webhook_id, event_type, payload, next_attempt_at, created_at) values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        id,
        e.workspaceId,
        h.id,
        e.type,
        JSON.stringify({
          id,
          type: e.type,
          created_at: new Date(now).toISOString(),
          project: e.projectId,
          severity: sev,
          data: e.data,
        }),
        new Date(when),
        new Date(now),
      ],
    );
    n++;
  }
  return n;
}

// ---------- signing ----------

export function signWebhook(secret: string, timestampSec: number, body: string): string {
  return `t=${timestampSec},v1=${createHmac('sha256', secret).update(`${timestampSec}.${body}`).digest('hex')}`;
}

/** Receivers call this: constant-time compare plus a tolerance window against replay. */
export function verifyWebhook(
  secret: string,
  header: string,
  body: string,
  nowSec: number,
  toleranceSec = 300,
): boolean {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = Buffer.from(signWebhook(secret, t, body).split('v1=')[1]!, 'hex');
  const got = Buffer.from(m[2]!, 'hex');
  return expected.length === got.length && expected.equals(got);
}

// ---------- SSRF guard ----------

function privateIPv4(a: number[]): boolean {
  const [x, y] = a as [number, number];
  return (
    x === 10 ||
    x === 127 ||
    x === 0 ||
    (x === 169 && y === 254) ||
    (x === 172 && y >= 16 && y <= 31) ||
    (x === 192 && y === 168) ||
    (x === 100 && y >= 64 && y <= 127) ||
    x >= 224
  );
}

export function isPrivateAddress(ip: string): boolean {
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (v4) return privateIPv4([Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])]);
  const l = ip.toLowerCase();
  return (
    l === '::1' ||
    l === '::' ||
    l.startsWith('fc') ||
    l.startsWith('fd') ||
    l.startsWith('fe8') ||
    l.startsWith('fe9') ||
    l.startsWith('fea') ||
    l.startsWith('feb')
  );
}

export type Resolver = (host: string) => Promise<string[]>;
export const defaultResolver: Resolver = async (host) =>
  (await lookup(host, { all: true })).map((a) => a.address);

export async function assertSafeWebhookUrl(
  url: string,
  opts: { resolve?: Resolver; allowHttp?: boolean } = {},
): Promise<void> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new BuiryError('invalid_input', 'webhook url is not valid');
  }
  if (u.protocol !== 'https:' && !(opts.allowHttp && u.protocol === 'http:'))
    throw new BuiryError('invalid_input', 'webhook urls must use https');
  if (u.username || u.password)
    throw new BuiryError('invalid_input', 'webhook urls must not contain credentials');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local')
  )
    throw new BuiryError('invalid_input', 'webhook host is not allowed');
  const addrs = isIP(host) ? [host] : await (opts.resolve ?? defaultResolver)(host).catch(() => []);
  if (addrs.length === 0) throw new BuiryError('invalid_input', 'webhook host does not resolve');
  if (addrs.some(isPrivateAddress))
    throw new BuiryError('invalid_input', 'webhook host resolves to a private or internal address');
}

export function formatForKind(
  kind: HookRow['kind'],
  payload: { type: string; severity?: string; data: Record<string, unknown>; project: string },
): unknown {
  const text = `[Buiry] ${payload.type}${payload.severity ? ` (${payload.severity})` : ''} in ${payload.project}: ${String(payload.data.detail ?? payload.data.text ?? JSON.stringify(payload.data)).slice(0, 300)}`;
  if (kind === 'slack') return { text };
  if (kind === 'discord') return { content: text };
  return payload;
}

export const hashSecret = (s: string): string => createHash('sha256').update(s).digest('hex');
