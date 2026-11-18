// SPDX-License-Identifier: Apache-2.0
/**
 * The loggable identity of an error: its class name and, for Postgres or system errors, its code (SQLSTATE such as
 * 23505, or ECONNREFUSED). Never the message, which can quote stored values, hosts or user names (SECURITY_REVIEW
 * M5 and the error-text sweep).
 */
export function errorTag(e: unknown): { error: string; code?: string } {
  const x = e as { name?: unknown; code?: unknown } | null | undefined;
  const error = typeof x?.name === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(x.name) ? x.name : typeof e;
  const code = typeof x?.code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(x.code) ? x.code : undefined;
  return code ? { error, code } : { error };
}
