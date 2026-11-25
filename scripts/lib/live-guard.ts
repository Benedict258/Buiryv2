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

/** The networks a live run may use: testnet, or mainnet with the opt-in. Own accounts exist on these two only. */
export type LiveRunNetwork = 'testnet' | 'mainnet';

/**
 * Phase 14 A: the network guard plus the line a live script prints first, naming the network and the relayer hosts
 * it will use (hosts only, never a path or credential). Mainnet still needs BUIRY_ALLOW_MAINNET=1 (checkNetworkEnv).
 */
export function liveNetworkLine(
  env: Record<string, string | undefined>,
  relayerVars: string[],
): { ok: true; network: LiveRunNetwork; line: string } | { ok: false; message: string } {
  const n = liveNetwork(env);
  if (!n.ok) return { ok: false, message: `refused: network settings: ${n.problems.join('; ')}` };
  if (n.network !== 'testnet' && n.network !== 'mainnet')
    return {
      ok: false,
      message: `refused: live runs use testnet or mainnet; the settings name ${n.network}`,
    };
  const hosts = [...new Set(relayerVars.flatMap((v) => (env[v] ? [new URL(env[v]!).hostname] : [])))];
  return {
    ok: true,
    network: n.network,
    line: `network ${n.network} (${hosts.length > 1 ? 'relayers' : 'relayer'} ${hosts.join(', ')})`,
  };
}

/**
 * The isolation run, the handoff proof and the own-account check (Phase 14 A): the guard, then the network line as the
 * first output, before any adapter, gateway or connection exists. Runs on testnet, or on mainnet with the opt-in.
 * Exits 64 with names and hosts only.
 */
export function requireLiveNetwork(
  env: Record<string, string | undefined>,
  who: string,
  relayerVars: string[],
): LiveRunNetwork {
  const r = liveNetworkLine(env, relayerVars);
  if (!r.ok) {
    console.error(`[${who}] ${r.message}`);
    process.exit(64);
  }
  console.log(`[${who}] ${r.line}`);
  return r.network;
}

/** The two accounts every two-account live script uses (Phase 14 A). */
export const TWO_ACCOUNT_VARS = ['A', 'B'].flatMap((s) =>
  ['RELAYER_URL', 'ACCOUNT_ID', 'DELEGATE_KEY'].map((p) => `BYO_${s}_${p}`),
);

/**
 * Both accounts present and different: no missing name, not the same account id (case and spaces ignored), not the
 * same delegate key. Names only in every message. The owner wallet is checked after a read (`sameWalletProblem`).
 */
export function twoAccountProblems(env: Record<string, string | undefined>): string[] {
  const missing = TWO_ACCOUNT_VARS.filter((k) => !env[k]?.trim());
  if (missing.length) return [`missing: ${missing.join(', ')} (names only)`];
  const problems: string[] = [];
  const norm = (v: string | undefined) => (v ?? '').trim().toLowerCase();
  if (norm(env.BYO_A_ACCOUNT_ID) === norm(env.BYO_B_ACCOUNT_ID))
    problems.push('BYO_A_ACCOUNT_ID and BYO_B_ACCOUNT_ID are the same account; the two accounts must differ');
  if (env.BYO_A_DELEGATE_KEY!.trim() === env.BYO_B_DELEGATE_KEY!.trim())
    problems.push(
      'BYO_A_DELEGATE_KEY and BYO_B_DELEGATE_KEY are the same key, so the same signer; the two accounts must differ',
    );
  return problems;
}

/** The owners the relayer reports for the two accounts (read-only `POST /api/stats`) must differ. */
export function sameWalletProblem(ownerA: string, ownerB: string): string | undefined {
  return ownerA.trim().toLowerCase() === ownerB.trim().toLowerCase()
    ? 'both accounts are owned by the same wallet; the two accounts must have different owners'
    : undefined;
}

/**
 * The relayer's `/config` network must be the one the settings named. The served value comes from the response, so it is
 * printed only when it is a recognised network name (Phase 14b).
 */
export function relayerNetworkProblem(
  served: string | undefined,
  network: SuiNetworkName,
): string | undefined {
  if (served === network) return undefined;
  const shown =
    served === undefined
      ? 'an unknown network'
      : ['testnet', 'mainnet', 'devnet', 'localnet'].includes(served)
        ? served
        : 'an unrecognised network';
  return `the relayer serves ${shown}, not ${network}`;
}
