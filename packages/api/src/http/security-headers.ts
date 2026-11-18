import type { IncomingMessage } from 'node:http';
import type { TLSSocket } from 'node:tls';

/**
 * Content Security Policy for every response, including the dashboard's static files. The dashboard loads only
 * its own hashed script, stylesheet and self-hosted fonts and talks only to its own origin (`/v1`, the SSE stream),
 * so everything is `'self'`. React sets inline styles through the DOM, which `style-src` does not restrict.
 * No report-uri: there is no unauthenticated report-collection route (Phase 2.3).
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export type CspMode = 'enforce' | 'report-only';

/** `BUIRY_CSP=report-only` sends the policy as Report-Only (a fallback if a screen breaks); enforced otherwise. */
export function cspModeFromEnv(env: Record<string, string | undefined>): CspMode {
  return env.BUIRY_CSP === 'report-only' ? 'report-only' : 'enforce';
}

/**
 * Headers set on every server response. Framing is always refused: `X-Frame-Options` plus an enforced
 * `frame-ancestors 'none'` (browsers ignore frame-ancestors in a Report-Only policy). HSTS only over https.
 */
export function securityHeaders(o: { https: boolean; csp: CspMode }): Record<string, string> {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    ...(o.csp === 'enforce'
      ? { 'content-security-policy': CONTENT_SECURITY_POLICY }
      : {
          'content-security-policy': "frame-ancestors 'none'",
          'content-security-policy-report-only': CONTENT_SECURITY_POLICY,
        }),
    ...(o.https ? { 'strict-transport-security': 'max-age=31536000' } : {}),
  };
}

/**
 * Whether the client reached us over https: a TLS socket, or, behind trusted proxies (`BUIRY_TRUSTED_PROXY_HOPS`),
 * the last `X-Forwarded-Proto` value, which the nearest proxy sets. With no trusted proxy the header is ignored,
 * since any client can send it.
 */
export function requestIsHttps(req: IncomingMessage, trustedProxyHops: number): boolean {
  if ((req.socket as TLSSocket).encrypted) return true;
  if (trustedProxyHops < 1) return false;
  const raw = req.headers['x-forwarded-proto'];
  const values = (Array.isArray(raw) ? raw.join(',') : (raw ?? ''))
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return values[values.length - 1] === 'https';
}
