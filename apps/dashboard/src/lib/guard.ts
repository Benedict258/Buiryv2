/**
 * Where an unauthenticated visitor should be sent, or null to leave them where they are.
 *
 * The emailed sign-in link is `/auth/email?token=...` (built by the API). The token has to reach the sign-in
 * page as its own `token` query parameter; wrapping the whole link in `next` would hide it and the one-time
 * token would never be exchanged for a session.
 */
export function signedOutRedirect(pathname: string, search: string): string | null {
  if (pathname === '/signin' || pathname.startsWith('/showcase/')) return null;
  if (pathname === '/auth/email') return `/signin${search}`;
  return `/signin?next=${encodeURIComponent(pathname + search)}`;
}
