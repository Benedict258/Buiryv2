// SPDX-License-Identifier: Apache-2.0
import type { Evidence, EventType, MemoryType } from './types.js';
import { MEMORY_TYPES, TIER_A_EVENTS, TIER_B_EVENTS } from './types.js';

export const PROTOCOL_VERSION = 1;

export interface MemoryHeader {
  evt: EventType;
  id: string;
  type?: MemoryType;
  branch: string;
  agent: string;
  /** Related memory (supersede, contest, confirm). */
  by?: string;
  /** Source memory (merge lineage). */
  ref?: string;
  /** Snapshot: derived confidence. */
  conf?: string;
  /** Snapshot: signal counts, e.g. "helped:3,wrong:0". */
  sig?: string;
}

export interface DecodedMemory {
  header: MemoryHeader;
  body: string;
  evidence: Evidence[];
}

export type DecodeResult = { ok: true; value: DecodedMemory } | { ok: false; error: string };

const VALUE_RE = /^[A-Za-z0-9._:,-]{1,128}$/;
const KEY_ORDER = ['evt', 'id', 'type', 'branch', 'agent', 'by', 'ref', 'conf', 'sig'] as const;
const ALL_EVENTS: readonly string[] = [...TIER_A_EVENTS, ...TIER_B_EVENTS];

export function encodeHeader(h: MemoryHeader): string {
  const parts: string[] = [`buiry/${PROTOCOL_VERSION}`];
  for (const k of KEY_ORDER) {
    const v = h[k];
    if (v === undefined) continue;
    if (!VALUE_RE.test(v)) throw new Error(`invalid header value for ${k}`);
    parts.push(`${k}=${v}`);
  }
  if (!ALL_EVENTS.includes(h.evt)) throw new Error('unknown event type');
  return `[${parts.join(' ')}]`;
}

/** Percent-style escape for evidence values so they never contain space, '=', ']' or newlines. */
function esc(v: string): string {
  return v.replace(
    // eslint-disable-next-line no-control-regex
    /[ \t%=\]@\u0000-\u001f\u007f]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'),
  );
}
function unesc(v: string): string {
  return v.replace(/%([0-9a-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

export function encodeEvidenceLine(e: Evidence): string {
  switch (e.kind) {
    case 'tx':
      return `ev: tx=${esc(e.digest)} net=${esc(e.network)}`;
    case 'object':
      return `ev: obj=${esc(e.id)}${e.version !== undefined ? '@' + esc(e.version) : ''} net=${esc(e.network)}`;
    case 'package':
      return `ev: pkg=${esc(e.id)} net=${esc(e.network)}`;
    case 'file':
      return `ev: file=${esc(e.path)}${e.commit !== undefined ? '@' + esc(e.commit) : ''}`;
    case 'url':
      return `ev: url=${esc(e.href)}`;
    case 'test':
      return `ev: test=${esc(e.name)}:${e.result}`;
  }
}

function lastIndexOfAt(s: string): number {
  // '@' inside values is escaped, so the only raw '@' is the separator.
  return s.indexOf('@');
}

export function decodeEvidenceLine(line: string): Evidence | null {
  if (!line.startsWith('ev: ')) return null;
  const fields = new Map<string, string>();
  for (const tok of line.slice(4).split(' ')) {
    const i = tok.indexOf('=');
    if (i <= 0) return null;
    fields.set(tok.slice(0, i), tok.slice(i + 1));
  }
  const net = fields.get('net');
  const tx = fields.get('tx');
  if (tx !== undefined && net !== undefined) return { kind: 'tx', digest: unesc(tx), network: unesc(net) };
  const obj = fields.get('obj');
  if (obj !== undefined && net !== undefined) {
    const i = lastIndexOfAt(obj);
    return i >= 0
      ? { kind: 'object', id: unesc(obj.slice(0, i)), version: unesc(obj.slice(i + 1)), network: unesc(net) }
      : { kind: 'object', id: unesc(obj), network: unesc(net) };
  }
  const pkg = fields.get('pkg');
  if (pkg !== undefined && net !== undefined) return { kind: 'package', id: unesc(pkg), network: unesc(net) };
  const file = fields.get('file');
  if (file !== undefined) {
    const i = lastIndexOfAt(file);
    return i >= 0
      ? { kind: 'file', path: unesc(file.slice(0, i)), commit: unesc(file.slice(i + 1)) }
      : { kind: 'file', path: unesc(file) };
  }
  const url = fields.get('url');
  if (url !== undefined) return { kind: 'url', href: unesc(url) };
  const test = fields.get('test');
  if (test !== undefined) {
    const i = test.lastIndexOf(':');
    const result = test.slice(i + 1);
    if (i < 0 || (result !== 'pass' && result !== 'fail')) return null;
    return { kind: 'test', name: unesc(test.slice(0, i)), result };
  }
  return null;
}

const ESCAPE_LINE_RE = /^\\*(ev:|\[buiry\/)/;
const UNESCAPE_LINE_RE = /^\\+(ev:|\[buiry\/)/;

/** Encodes one durable event: header line, body, evidence lines. Body must not contain '\r'. */
export function encodeMemory(m: { header: MemoryHeader; body: string; evidence?: Evidence[] }): string {
  if (m.body.includes('\r')) throw new Error('body must be normalised to \\n');
  const body = m.body
    .split('\n')
    .map((l) => (ESCAPE_LINE_RE.test(l) ? '\\' + l : l))
    .join('\n');
  const lines = [encodeHeader(m.header), body];
  for (const e of m.evidence ?? []) lines.push(encodeEvidenceLine(e));
  return lines.join('\n');
}

export function decodeMemory(text: string): DecodeResult {
  const nl = text.indexOf('\n');
  const headerLine = nl === -1 ? text : text.slice(0, nl);
  if (nl === -1) return { ok: false, error: 'missing body' };
  const header = decodeHeader(headerLine);
  if (!header.ok) return header;
  const lines = text.slice(nl + 1).split('\n');
  const evidence: Evidence[] = [];
  while (lines.length > 1 && lines[lines.length - 1]!.startsWith('ev: ')) {
    const ev = decodeEvidenceLine(lines[lines.length - 1]!);
    if (!ev) return { ok: false, error: 'malformed evidence line' };
    evidence.unshift(ev);
    lines.pop();
  }
  const body = lines.map((l) => (UNESCAPE_LINE_RE.test(l) ? l.slice(1) : l)).join('\n');
  return { ok: true, value: { header: header.value, body, evidence } };
}

export function decodeHeader(line: string): { ok: true; value: MemoryHeader } | { ok: false; error: string } {
  if (line.length > 1024) return { ok: false, error: 'header too long' };
  const m = /^\[buiry\/(\d+) ([^\]]*)\]$/.exec(line);
  if (!m) return { ok: false, error: 'not a buiry header' };
  if (Number(m[1]) !== PROTOCOL_VERSION) return { ok: false, error: `unsupported protocol version ${m[1]}` };
  const raw = new Map<string, string>();
  for (const tok of (m[2] ?? '').split(' ')) {
    const i = tok.indexOf('=');
    if (i <= 0) return { ok: false, error: 'malformed header field' };
    const k = tok.slice(0, i);
    const v = tok.slice(i + 1);
    if (!(KEY_ORDER as readonly string[]).includes(k))
      return { ok: false, error: `unknown header field ${k}` };
    if (raw.has(k)) return { ok: false, error: `duplicate header field ${k}` };
    if (!VALUE_RE.test(v)) return { ok: false, error: `invalid value for ${k}` };
    raw.set(k, v);
  }
  const evt = raw.get('evt');
  const id = raw.get('id');
  const branch = raw.get('branch');
  const agent = raw.get('agent');
  if (!evt || !ALL_EVENTS.includes(evt)) return { ok: false, error: 'missing or unknown evt' };
  if (!id || !branch || !agent) return { ok: false, error: 'missing required header field' };
  const type = raw.get('type');
  if (type !== undefined && !(MEMORY_TYPES as readonly string[]).includes(type)) {
    return { ok: false, error: 'unknown memory type' };
  }
  const header: MemoryHeader = { evt: evt as EventType, id, branch, agent };
  if (type !== undefined) header.type = type as MemoryType;
  for (const k of ['by', 'ref', 'conf', 'sig'] as const) {
    const v = raw.get(k);
    if (v !== undefined) header[k] = v;
  }
  return { ok: true, value: header };
}
