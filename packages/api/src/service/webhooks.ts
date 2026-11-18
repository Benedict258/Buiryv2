import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { BuiryError } from '@buiry/core';
import type { Tx } from '../db/db.js';
import { WEBHOOK_EVENTS, assertSafeWebhookUrl, formatForKind, signWebhook, type Resolver } from './events.js';
import type { Principal, ServiceDeps } from './types.js';

/**
 * What a failed delivery records (`webhook_deliveries.last_error`, shown to admins): Buiry's own messages as they are
 * (the destination check uses fixed text), otherwise a stable code and a short message chosen from the error code.
 * Never the exception message, which can name resolved addresses or certificate details (error-text sweep A4).
 */
export function deliveryErrorText(e: unknown): string {
  if (e instanceof BuiryError) return e.message;
  const code = (e as { code?: unknown })?.code;
  const name = (e as { name?: unknown })?.name;
  if (name === 'AbortError' || code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT')
    return 'timeout: the endpoint did not answer in time';
  if (code === 'ECONNREFUSED') return 'connection_refused: the endpoint refused the connection';
  if (code === 'ECONNRESET' || code === 'EPIPE')
    return 'connection_reset: the endpoint closed the connection';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns: the endpoint host did not resolve';
  if (typeof code === 'string' && /CERT|TLS|SSL|SELF_SIGNED|ALTNAME/i.test(code))
    return 'tls: the endpoint certificate was not accepted';
  return 'delivery_failed: the delivery could not be completed';
}
import { assertManage } from './members.js';
import { actorOf, genId, logActivity, notFound } from './util.js';

const key = (secretKey: string) => createHash('sha256').update(`webhook-secrets:${secretKey}`).digest();

export function sealSecret(secretKey: string, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(secretKey), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `enc:v1:${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${enc.toString('base64url')}`;
}

/** Opens a webhook secret; during a key rotation it falls back to the previous key. */
export function openSecret(secretKey: string, sealed: string, previousKey?: string): string {
  try {
    return openWith(secretKey, sealed);
  } catch (e) {
    if (!previousKey) throw e;
    return openWith(previousKey, sealed);
  }
}

function openWith(secretKey: string, sealed: string): string {
  const [, , iv, tag, enc] = sealed.split(':');
  const d = createDecipheriv('aes-256-gcm', key(secretKey), Buffer.from(iv!, 'base64url'));
  d.setAuthTag(Buffer.from(tag!, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(enc!, 'base64url')), d.final()]).toString('utf8');
}

export interface WebhookInput {
  name: string;
  kind: 'slack' | 'discord' | 'generic';
  url: string;
  events: string[];
  projectId?: string;
}

export interface WebhookOpts {
  resolve?: Resolver;
  allowHttp?: boolean;
  /** Tests only: allow private addresses (a local receiver). */
  allowPrivate?: boolean;
}

export async function createWebhook(
  deps: ServiceDeps,
  tx: Tx,
  p: Principal,
  i: WebhookInput,
  o: WebhookOpts = {},
) {
  assertManage(p);
  await assertSafeWebhookUrl(i.url, o);
  const bad = i.events.filter((e) => e !== '*' && !(WEBHOOK_EVENTS as readonly string[]).includes(e));
  if (bad.length) throw new BuiryError('invalid_input', `unknown webhook events: ${bad.join(', ')}`);
  if (i.projectId) {
    const pr = await tx.query('select 1 from projects where id = $1', [i.projectId]);
    if (!pr.rows.length) throw notFound('project');
  }
  const id = genId(deps, 'evt');
  const secret = `whsec_${randomBytes(24).toString('base64url')}`;
  await tx.query(
    `insert into webhooks (id, workspace_id, project_id, name, kind, url, secret, events) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id,
      p.workspaceId,
      i.projectId ?? null,
      i.name,
      i.kind,
      i.url,
      sealSecret(deps.secretKey, secret),
      i.events,
    ],
  );
  await logActivity(tx, deps, {
    workspaceId: p.workspaceId,
    ...(i.projectId ? { projectId: i.projectId } : {}),
    actor: actorOf(p),
    operation: 'webhook.create',
    target: { webhookId: id },
    result: 'success',
  });
  return { id, secret }; // the signing secret is shown once
}

export async function listWebhooks(tx: Tx, p: Principal) {
  assertManage(p);
  const r = await tx.query<{
    id: string;
    name: string;
    kind: string;
    url: string;
    events: string[];
    status: string;
    paused_reason: string | null;
    project_id: string | null;
  }>(
    'select id, name, kind, url, events, status, paused_reason, project_id from webhooks order by created_at',
  );
  return r.rows;
}

export async function deleteWebhook(deps: ServiceDeps, tx: Tx, p: Principal, id: string) {
  assertManage(p);
  const r = await tx.query('delete from webhooks where id = $1 returning id', [id]);
  if (!r.rows[0]) throw notFound('webhook');
  await logActivity(tx, deps, {
    workspaceId: p.workspaceId,
    actor: actorOf(p),
    operation: 'webhook.delete',
    target: { webhookId: id },
    result: 'success',
  });
}

export async function listDeliveries(tx: Tx, p: Principal, webhookId: string) {
  assertManage(p);
  const r = await tx.query<{
    id: string;
    event_type: string;
    state: string;
    attempts: number;
    status_code: number | null;
    duration_ms: number | null;
    last_error: string | null;
    created_at: Date;
  }>(
    'select id, event_type, state, attempts, status_code, duration_ms, last_error, created_at from webhook_deliveries where webhook_id = $1 order by created_at desc limit 100',
    [webhookId],
  );
  return r.rows;
}

/** Queue a fresh delivery of a previous payload (replay). */
export async function replayDelivery(deps: ServiceDeps, tx: Tx, p: Principal, deliveryId: string) {
  assertManage(p);
  const d = await tx.query<{ webhook_id: string; event_type: string; payload: unknown }>(
    'select webhook_id, event_type, payload from webhook_deliveries where id = $1',
    [deliveryId],
  );
  if (!d.rows[0]) throw notFound('delivery');
  const id = genId(deps, 'evt');
  await tx.query(
    `insert into webhook_deliveries (id, workspace_id, webhook_id, event_type, payload, next_attempt_at, created_at) values ($1,$2,$3,$4,$5,$6,$6)`,
    [
      id,
      p.workspaceId,
      d.rows[0].webhook_id,
      d.rows[0].event_type,
      JSON.stringify(d.rows[0].payload),
      new Date(deps.now()),
    ],
  );
  return { id };
}

export async function testWebhook(deps: ServiceDeps, tx: Tx, p: Principal, webhookId: string) {
  assertManage(p);
  const w = await tx.query<{ id: string }>('select id from webhooks where id = $1', [webhookId]);
  if (!w.rows[0]) throw notFound('webhook');
  const id = genId(deps, 'evt');
  await tx.query(
    `insert into webhook_deliveries (id, workspace_id, webhook_id, event_type, payload, next_attempt_at, created_at) values ($1,$2,$3,'test',$4,$5,$5)`,
    [
      id,
      p.workspaceId,
      webhookId,
      JSON.stringify({
        id,
        type: 'test',
        created_at: new Date(deps.now()).toISOString(),
        project: 'none',
        data: { detail: 'Buiry test delivery' },
      }),
      new Date(deps.now()),
    ],
  );
  return { id };
}

// ---------- delivery (called by the worker) ----------

/**
 * Sends one webhook request to an address that was already checked. The connection goes to `address` (no second
 * DNS lookup, so a rebinding answer cannot redirect it); TLS still verifies the certificate for the URL's host.
 */
export type WebhookSender = (r: {
  url: URL;
  address: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}) => Promise<number>;

export const pinnedSender: WebhookSender = ({ url, address, headers, body, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const family = isIP(address) === 6 ? 6 : 4;
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        method: 'POST',
        headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
        servername: url.hostname,
        agent: false,
        timeout: timeoutMs,
        // Pin the connection to the checked address whatever DNS says now.
        lookup: ((_host: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) =>
          opts?.all ? cb(null, [{ address, family }]) : cb(null, address, family)) as never,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end(body);
  });

export interface DeliveryOpts extends WebhookOpts {
  /** Test double for the whole HTTP call (bypasses the pinned connection). */
  fetch?: typeof fetch;
  /** Replaces the pinned sender (tests). */
  send?: WebhookSender;
  maxAttempts?: number;
  timeoutMs?: number;
  /** Consecutive failed deliveries after which an endpoint is paused. */
  pauseAfter?: number;
  limit?: number;
}

export interface DeliveryReport {
  delivered: number;
  failed: number;
  retried: number;
  paused: string[];
}

const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000];

export async function deliverDue(deps: ServiceDeps, o: DeliveryOpts = {}): Promise<DeliveryReport> {
  const rep: DeliveryReport = { delivered: 0, failed: 0, retried: 0, paused: [] };
  const due = await deps.db.system((tx) =>
    tx.query<{
      id: string;
      workspace_id: string;
      webhook_id: string;
      event_type: string;
      payload: { type: string; severity?: string; data: Record<string, unknown>; project: string };
      attempts: number;
    }>(
      `select d.id, d.workspace_id, d.webhook_id, d.event_type, d.payload, d.attempts from webhook_deliveries d
         join webhooks w on w.id = d.webhook_id where d.state = 'pending' and d.next_attempt_at <= $1 and w.status = 'active' order by d.next_attempt_at limit $2`,
      [new Date(deps.now()), o.limit ?? 50],
    ),
  );
  for (const d of due.rows) {
    const hook = (
      await deps.db.system((tx) =>
        tx.query<{ url: string; secret: string; kind: 'slack' | 'discord' | 'generic'; status: string }>(
          'select url, secret, kind, status from webhooks where id = $1',
          [d.webhook_id],
        ),
      )
    ).rows[0];
    if (!hook || hook.status !== 'active') continue;
    const t0 = deps.now();
    let status: number | null = null;
    let error: string | null = null;
    try {
      // Resolved and checked once; the request then connects to exactly the checked address (M2: no rebinding
      // window between the check and the connection).
      const addrs = await assertSafeWebhookUrl(hook.url, o);
      const body = JSON.stringify(formatForKind(hook.kind, d.payload));
      const ts = Math.floor(deps.now() / 1000);
      const headers = {
        'content-type': 'application/json',
        'buiry-signature': signWebhook(
          openSecret(deps.secretKey, hook.secret, deps.previousSecretKey),
          ts,
          body,
        ),
        'buiry-event': d.event_type,
        'buiry-delivery': d.id,
      };
      const timeoutMs = o.timeoutMs ?? 8000;
      if (o.fetch) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          status = (
            await o.fetch(hook.url, {
              method: 'POST',
              headers,
              body,
              signal: ctrl.signal,
              redirect: 'manual',
            })
          ).status;
        } finally {
          clearTimeout(timer);
        }
      } else {
        status = await (o.send ?? pinnedSender)({
          url: new URL(hook.url),
          address: addrs[0]!,
          headers,
          body,
          timeoutMs,
        });
      }
      if (status < 200 || status >= 300) error = `HTTP ${status}`;
    } catch (e) {
      error = deliveryErrorText(e);
    }
    const attempts = d.attempts + 1;
    const ms = deps.now() - t0;
    await deps.db.system(async (tx) => {
      if (!error) {
        await tx.query(
          `update webhook_deliveries set state = 'delivered', attempts = $1, status_code = $2, duration_ms = $3, last_error = null where id = $4`,
          [attempts, status, ms, d.id],
        );
        rep.delivered++;
        return;
      }
      const terminal = attempts >= (o.maxAttempts ?? 6);
      await tx.query(
        `update webhook_deliveries set state = $1, attempts = $2, status_code = $3, duration_ms = $4, last_error = $5, next_attempt_at = $6 where id = $7`,
        [
          terminal ? 'failed' : 'pending',
          attempts,
          status,
          ms,
          error,
          new Date(deps.now() + (BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)] ?? 3_600_000)),
          d.id,
        ],
      );
      if (terminal) rep.failed++;
      else rep.retried++;
      // A failing endpoint is paused and surfaced instead of being retried forever.
      const recent = await tx.query<{ state: string }>(
        'select state from webhook_deliveries where webhook_id = $1 order by created_at desc limit $2',
        [d.webhook_id, o.pauseAfter ?? 5],
      );
      if (recent.rows.length >= (o.pauseAfter ?? 5) && recent.rows.every((r) => r.state !== 'delivered')) {
        const paused = await tx.query(
          `update webhooks set status = 'paused', paused_reason = $1 where id = $2 and status = 'active' returning id`,
          [`${o.pauseAfter ?? 5} consecutive failures; last error: ${error}`, d.webhook_id],
        );
        if (paused.rows.length) {
          await tx.query(
            `insert into audit_log (id, workspace_id, actor, action, target, detail) values ($1,$2,'system','webhook.paused',$3,$4)`,
            [genId(deps, 'evt'), d.workspace_id, d.webhook_id, JSON.stringify({ error })],
          );
          rep.paused.push(d.webhook_id);
        }
      }
    });
  }
  return rep;
}
