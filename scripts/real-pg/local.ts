/** The real-Postgres scripts run only against a local throwaway server unless explicitly allowed. */
export function assertLocalDatabase(url: string, env: Record<string, string | undefined>): void {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (!['localhost', '127.0.0.1', '::1'].includes(host) && env.BUIRY_SEED_ALLOW_REMOTE !== '1')
    throw new Error(`database host "${host}" is not local; set BUIRY_SEED_ALLOW_REMOTE=1 to allow it`);
}
