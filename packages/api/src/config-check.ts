import { isGatewayConfigured, tatumConfigProblems } from '@buiry/chain';
import { checkNetworkEnv } from '@buiry/core';
import { Ed25519Signer } from '@buiry/storage';

type Env = Record<string, string | undefined>;

const WORKSPACE_ID = /^wsp_[0-9A-Z]{26}$/;
const PLACEHOLDER = /^(change[-_ ]?me|changeme|secret|password|test|example|placeholder|x+|0+)/i;

/**
 * Preview mode (BUIRY_PREVIEW=1, Phase 9 C1): testers bring their own Walrus testnet accounts (BD36), so there is no
 * shared storage account at all. Checked in every environment, not only production. Messages name variables only.
 */
export function previewProblems(env: Env): string[] {
  if (env.BUIRY_PREVIEW !== '1') return [];
  const p: string[] = [];
  if (env.BUIRY_MANAGED?.trim() !== 'off')
    p.push('preview mode needs BUIRY_MANAGED=off: testers connect their own Walrus accounts');
  if (env.BUIRY_MANAGED_MULTI_TENANT === '1')
    p.push('BUIRY_MANAGED_MULTI_TENANT=1 is refused in preview mode: there is no shared account to share');
  if (env.BUIRY_MANAGED_WORKSPACE_ID?.trim())
    p.push('BUIRY_MANAGED_WORKSPACE_ID must not be set in preview mode: there is no shared account');
  return p;
}

/**
 * Phase 12 B: network settings every server checks before building anything. A network must be named whenever a
 * relayer URL or the chain gateway is configured, or the server runs in production or preview mode; the relayer host,
 * WALRUS_NETWORK and TATUM_NETWORK must agree; mainnet needs BUIRY_ALLOW_MAINNET=1. Messages name variables and
 * relayer hosts only.
 */
export function runtimeNetworkProblems(env: Env): string[] {
  const gatewayConfigured = isGatewayConfigured(env); // the chain package's check; the key stays in packages/chain
  const relayer = Object.keys(env).some((k) => /_RELAYER_URL$/.test(k) && !!env[k]?.trim());
  const requireNetwork =
    env.NODE_ENV === 'production' || env.BUIRY_PREVIEW === '1' || gatewayConfigured || relayer;
  return checkNetworkEnv(env, { requireNetwork, gatewayConfigured }).problems;
}

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

  const prev = env.BUIRY_SECRET_KEY_PREVIOUS;
  if (prev !== undefined && prev !== '') {
    if (prev.length < 32) p.push('BUIRY_SECRET_KEY_PREVIOUS must be at least 32 characters');
    else if (prev === key) p.push('BUIRY_SECRET_KEY_PREVIOUS is the same as BUIRY_SECRET_KEY; remove it');
  }

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
  // Managed-account tenancy (BD42): production names the one workspace that owns the shared account, or switches
  // managed storage off explicitly. Never "first workspace to create a project wins", never every workspace (A26).
  const managed = env.BUIRY_MANAGED?.trim();
  const managedOff = managed === 'off';
  if (managed && !managedOff) p.push('BUIRY_MANAGED must be off or unset');
  if (env.BUIRY_MANAGED_MULTI_TENANT === '1')
    p.push(
      'BUIRY_MANAGED_MULTI_TENANT=1 is refused in production: one Seal session would reach every workspace on the shared account (A26)',
    );
  const tenant = env.BUIRY_MANAGED_WORKSPACE_ID?.trim();
  if (managedOff && tenant) p.push('set BUIRY_MANAGED_WORKSPACE_ID or BUIRY_MANAGED=off, not both');
  if (!managedOff) {
    if (!tenant)
      p.push(
        'BUIRY_MANAGED_WORKSPACE_ID is not set: name the workspace that owns the shared storage account, or set BUIRY_MANAGED=off (first deploy: docs/DEPLOYMENT.md)',
      );
    else if (!WORKSPACE_ID.test(tenant)) p.push('BUIRY_MANAGED_WORKSPACE_ID is not a workspace id (wsp_...)');
    if (set.length === 0) p.push('no managed Walrus account is configured (WALRUS_*): set BUIRY_MANAGED=off');
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
  const days = env.BUIRY_AGENT_TOKEN_MAX_DAYS;
  if (days !== undefined && !/^\d{1,4}$/.test(days))
    p.push('BUIRY_AGENT_TOKEN_MAX_DAYS must be a whole number of days (0 for no expiry)');
  const hops = env.BUIRY_TRUSTED_PROXY_HOPS;
  if (hops !== undefined && !/^[0-5]$/.test(hops))
    p.push('BUIRY_TRUSTED_PROXY_HOPS must be a whole number from 0 to 5 (1 behind one AWS ALB)');
  if (env.BUIRY_ROLE && !['all', 'api', 'worker'].includes(env.BUIRY_ROLE))
    p.push('BUIRY_ROLE must be all, api or worker');
  return p;
}
