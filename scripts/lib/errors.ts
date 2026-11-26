/**
 * Phase 14b B: what a live script may print about an error. A relayer error prints as
 * `RelayerError class=<class> kind=<kind>[ status=<n>][ cause=<code>]`; any other error prints its name only. Never the
 * message (for a relayer error that is the relayer's own response text), a URL, a header, a key or any other value.
 * Each field is checked against a strict pattern before it is printed, so a field that does not fit prints a
 * placeholder instead. The script's own refusals, whose messages it writes itself, are thrown as `ScriptRefusal` and
 * print as written.
 */

/** A refusal whose message the live script wrote itself (names, hosts and network names only). */
export class ScriptRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptRefusal';
  }
}

/** Coarse error class: where it failed. */
export type ErrorClass = 'timeout' | 'network' | 'http' | 'parse' | 'invalid-response' | 'local';

const KIND = /^[a-z_]{1,32}$/;
const CAUSE = /^[A-Z][A-Z0-9_]{0,39}$/;
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
const API_CODE = /^[a-z_]{1,40}$/;

export function errorClass(kind: string, status: number | undefined): ErrorClass {
  if (kind === 'timeout') return 'timeout';
  if (status === undefined)
    return kind === 'unavailable' ? 'network' : kind === 'unknown' ? 'invalid-response' : 'local';
  if (status >= 200 && status < 300) return 'parse';
  return 'http';
}

export function errorText(e: unknown): string {
  if (e instanceof ScriptRefusal) return e.message;
  const o = (typeof e === 'object' && e !== null ? e : {}) as {
    name?: unknown;
    kind?: unknown;
    status?: unknown;
    netCode?: unknown;
  };
  if (o.name === 'RelayerError' && typeof o.kind === 'string') {
    const kind = KIND.test(o.kind) ? o.kind : 'unrecognised';
    const status =
      typeof o.status === 'number' && Number.isInteger(o.status) && o.status >= 100 && o.status <= 599
        ? o.status
        : undefined;
    const cause = typeof o.netCode === 'string' && CAUSE.test(o.netCode) ? o.netCode : undefined;
    return [
      'RelayerError',
      `class=${errorClass(kind, status)}`,
      `kind=${kind}`,
      ...(status !== undefined ? [`status=${status}`] : []),
      ...(cause ? [`cause=${cause}`] : []),
    ].join(' ');
  }
  // Phase 14c: an API error prints its plain error code (for example invalid_input), never its message.
  if (o.name === 'BuiryError') {
    const c = (o as { code?: unknown }).code;
    return `BuiryError code=${typeof c === 'string' && API_CODE.test(c) ? c : 'unrecognised'}`;
  }
  return typeof o.name === 'string' && NAME.test(o.name) ? o.name : 'Error';
}
