import { tatumConfigProblems } from '@buiry/chain';
import { Ed25519Signer } from '@buiry/storage';

type Env = Record<string, string | undefined>;

const PLACEHOLDER = /^(change[-_ ]?me|changeme|secret|password|test|example|placeholder|x+|0+)/i;

/**
 * Settings a production server must not start with. Messages name variables only, never values. Called by
 * buildRuntime when NODE_ENV=production; `buiry doctor`-style tooling can call it too.
 */
export function productionProblems(env: Env): string[] {
  const p: string[] = [];
  const has = (k: string) => !!env[k]?.trim();

  if (!has('DATABASE_URL')) p.push('DATABASE_URL is not set (production never uses the in-memory database)');

  const key = env.BUIRY_SECRET_KEY ?? '';
  if (key.length < 32) p.push('BUIRY_SECRET_KEY must be at least 32 characters');
  else if (PLACEHOLDER.test(key) || new Set(key).size < 12)
    p.push('BUIRY_SECRET_KEY looks like a placeholder or has too little variety; generate a random value');

  const base = env.BUIRY_BASE_URL ?? '';
  if (!base) p.push('BUIRY_BASE_URL is not set');
  else if (!base.startsWith('https://')) p.push('BUIRY_BASE_URL must use https');
  for (const o of (env.BUIRY_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean))
    if (!o.startsWith('https://')) p.push('BUIRY_ALLOWED_ORIGINS must list https origins only');

  const walrus = ['WALRUS_RELAYER_URL', 'WALRUS_ACCOUNT_ID', 'WALRUS_DELEGATE_KEY'];
  const set = walrus.filter(has);
  if (set.length && set.length < walrus.length)
    p.push(`Walrus settings are incomplete: set ${walrus.filter((k) => !has(k)).join(', ')} or none of them`);
  if (set.length === walrus.length) {
    if (!has('WALRUS_NETWORK')) p.push('WALRUS_NETWORK is not set');
    if (!env.WALRUS_RELAYER_URL!.startsWith('https://')) p.push('WALRUS_RELAYER_URL must use https');
    try {
      new Ed25519Signer(env.WALRUS_DELEGATE_KEY!);
    } catch {
      p.push('WALRUS_DELEGATE_KEY is not a valid Ed25519 key');
    }
  }
  p.push(...tatumConfigProblems(env)); // the Tatum key is only ever read inside packages/chain

  for (const [id, secret] of [
    ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
    ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  ] as const)
    if (has(id) !== has(secret)) p.push(`${id} and ${secret} must be set together`);

  if (env.BUIRY_BYO_ALLOW_PRIVATE === '1')
    p.push('BUIRY_BYO_ALLOW_PRIVATE=1 is for development only; remove it');
  if (env.BUIRY_MAILER && !['smtp', 'off'].includes(env.BUIRY_MAILER))
    p.push(
      'BUIRY_MAILER must be smtp (or off) in production; the console and memory mailers are for development',
    );
  const hops = env.BUIRY_TRUSTED_PROXY_HOPS;
  if (hops !== undefined && !/^[0-5]$/.test(hops))
    p.push('BUIRY_TRUSTED_PROXY_HOPS must be a whole number from 0 to 5 (1 behind one AWS ALB)');
  if (env.BUIRY_ROLE && !['all', 'api', 'worker'].includes(env.BUIRY_ROLE))
    p.push('BUIRY_ROLE must be all, api or worker');
  return p;
}
