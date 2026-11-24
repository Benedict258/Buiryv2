/**
 * Phase 12 B2: the network guard every live script runs before it builds an adapter or a gateway. The network must be
 * named, every relayer host and WALRUS_NETWORK / TATUM_NETWORK must agree, an unrecognised relayer host needs
 * WALRUS_RELAYER_NETWORK, and mainnet needs BUIRY_ALLOW_MAINNET=1. Whether the chain gateway is configured comes from
 * the chain package's own check, so no script names the key. Messages name variables and hosts only.
 */
import { checkNetworkEnv, type SuiNetworkName } from '../../packages/core/src/index.js';
import { isGatewayConfigured } from '../../packages/chain/src/index.js';

export type LiveNetwork = { ok: true; network: SuiNetworkName } | { ok: false; problems: string[] };

export function liveNetwork(env: Record<string, string | undefined>): LiveNetwork {
  const r = checkNetworkEnv(env, { requireNetwork: true, gatewayConfigured: isGatewayConfigured(env) });
  return r.network ? { ok: true, network: r.network } : { ok: false, problems: r.problems };
}

/**
 * For the scripts that have only ever run on testnet (isolation, handoff proof, own-account check): the guard, then
 * testnet only. Running them on mainnet is a separate decision and a separate change. Exits 64 with names only.
 */
export function requireLiveTestnet(env: Record<string, string | undefined>, who: string): void {
  const n = liveNetwork(env);
  if (!n.ok) {
    console.error(`[${who}] refused: network settings: ${n.problems.join('; ')}`);
    process.exit(64);
  }
  if (n.network !== 'testnet') {
    console.error(`[${who}] refused: this script runs on testnet only; the settings name ${n.network}`);
    process.exit(64);
  }
  console.log(`[${who}] network ${n.network}`);
}
