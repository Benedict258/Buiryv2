import { checkNetworkEnv, type SuiNetworkName } from '../../packages/core/src/index.js';
import { LIVE_REQUIRED_ENV } from './proof-criteria.js';

/** Canary pacing (Phase 10): at most one canary write per hour. Pure. */
export const CANARY_MIN_GAP_MS = 60 * 60_000;

/** Whether a canary may run now, given when the last one started (ISO time) or null if none ever ran. */
export function canaryAllowed(
  lastAt: string | null,
  now: number,
): { ok: true } | { ok: false; waitMinutes: number } {
  if (lastAt === null) return { ok: true };
  const t = Date.parse(lastAt);
  if (Number.isNaN(t)) return { ok: false, waitMinutes: 60 }; // unreadable record: refuse on the safe side
  const gap = now - t;
  return gap >= CANARY_MIN_GAP_MS
    ? { ok: true }
    : { ok: false, waitMinutes: Math.ceil((CANARY_MIN_GAP_MS - gap) / 60_000) };
}

export type CanaryPreflight =
  { ok: true; network: SuiNetworkName; firstLine: string } | { ok: false; exitCode: number; message: string };

/**
 * Phase 12 C: everything the canary checks before it touches anything. Account settings present; network settings
 * consistent (named network, relayer host agrees, mainnet only with BUIRY_ALLOW_MAINNET=1); the chain gateway
 * configured, since without it there is no Seal session and a recall cannot return real results. Pure: the caller
 * passes the chain package's own "configured" answer. Messages name variables and hosts only.
 */
export function canaryPreflight(
  env: Record<string, string | undefined>,
  o: { gatewayConfigured: boolean },
): CanaryPreflight {
  const missing = LIVE_REQUIRED_ENV.canary.filter((k) => !env[k]);
  if (missing.length)
    return {
      ok: false,
      exitCode: 64,
      message: `missing: ${missing.join(', ')} (names only; see docs/LIVE_PROOF.md)`,
    };
  const net = checkNetworkEnv(env, { requireNetwork: true, gatewayConfigured: o.gatewayConfigured });
  if (!net.network)
    return { ok: false, exitCode: 64, message: `refused: network settings: ${net.problems.join('; ')}` };
  if (!o.gatewayConfigured)
    return {
      ok: false,
      exitCode: 64,
      message:
        'refused: the chain gateway is not configured, so there is no Seal session and a recall cannot return real results',
    };
  const host = new URL(env.BYO_A_RELAYER_URL!).hostname;
  return { ok: true, network: net.network, firstLine: `network ${net.network} (relayer ${host})` };
}
