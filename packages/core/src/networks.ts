// SPDX-License-Identifier: Apache-2.0
/**
 * Network consistency. Walrus Memory, the chain gateway, the relayer, the demo and every project must point at the
 * same Sui network; a mix (for example a Mainnet relayer with a Testnet gateway) silently breaks Seal sessions,
 * verification and expiry checks. Pure: callers supply the values.
 */

export type SuiNetworkName = 'mainnet' | 'testnet' | 'devnet';

const NAMES: readonly SuiNetworkName[] = ['mainnet', 'testnet', 'devnet'];

/** Accepts `mainnet` or `sui:mainnet` (any case). Returns undefined for anything else. */
export function normalizeSuiNetwork(value: string): SuiNetworkName | undefined {
  const v = value.trim().toLowerCase().replace(/^sui:/, '');
  return (NAMES as readonly string[]).includes(v) ? (v as SuiNetworkName) : undefined;
}

export interface NetworkSources {
  /** WALRUS_NETWORK */
  walrus?: string;
  /** TATUM_NETWORK */
  tatum?: string;
  /** `network` from the relayer's GET /config */
  relayer?: string;
  /** DEMO_NETWORK */
  demo?: string;
  /** Declared networks of active projects. Only `sui:*` entries are compared; other chains are ignored. */
  projects?: { id: string; networks: string[] }[];
}

export interface NetworkCheck {
  /** The agreed Sui network, when at least one source names one and none disagree. */
  network?: SuiNetworkName;
  /** One sentence per problem, naming the sources involved. Empty when consistent. */
  mismatches: string[];
}

const LABELS: Record<'walrus' | 'tatum' | 'relayer' | 'demo', string> = {
  walrus: 'WALRUS_NETWORK',
  tatum: 'TATUM_NETWORK',
  relayer: 'relayer /config network',
  demo: 'DEMO_NETWORK',
};

export function checkNetworks(s: NetworkSources): NetworkCheck {
  const mismatches: string[] = [];
  const named: { label: string; net: SuiNetworkName }[] = [];
  for (const key of ['walrus', 'tatum', 'relayer', 'demo'] as const) {
    const raw = s[key];
    if (raw === undefined || raw.trim() === '') continue;
    const net = normalizeSuiNetwork(raw);
    if (!net) mismatches.push(`${LABELS[key]}=${raw} is not a Sui network (mainnet, testnet or devnet)`);
    else named.push({ label: LABELS[key], net });
  }
  const distinct = [...new Set(named.map((n) => n.net))];
  if (distinct.length > 1)
    mismatches.push(`networks disagree: ${named.map((n) => `${n.label}=${n.net}`).join(', ')}`);
  const network = distinct.length === 1 && mismatches.length === 0 ? distinct[0] : undefined;

  if (network) {
    for (const p of s.projects ?? []) {
      const other = p.networks
        .filter((n) => n.trim().toLowerCase().startsWith('sui:'))
        .filter((n) => normalizeSuiNetwork(n) !== network);
      if (other.length)
        mismatches.push(`project ${p.id} declares ${other.join(', ')} but this deployment is on ${network}`);
    }
  }
  return { ...(network && mismatches.length === 0 ? { network } : {}), mismatches };
}

/** A project's declared networks may only name the deployment's Sui network (other chains are allowed). */
export function projectNetworkConflicts(
  networks: string[],
  deployment: SuiNetworkName | undefined,
): string[] {
  if (!deployment) return [];
  return networks.filter(
    (n) => n.trim().toLowerCase().startsWith('sui:') && normalizeSuiNetwork(n) !== deployment,
  );
}

/**
 * Walrus epoch length per Sui network: "an epoch is about 2 weeks on Mainnet and about 1 day on Testnet"
 * (https://docs.wal.app/walrus-memory/fundamentals/architecture/funding-storage.md). Consistent with live reads:
 * Mainnet memories lived 15 x 14 days, testnet memories 5.00 days. Devnet and unknown networks use the Mainnet
 * length, so expiry alerts come early rather than late.
 */
export const WALRUS_EPOCH_MS: Record<'mainnet' | 'testnet', number> = {
  mainnet: 14 * 86_400_000,
  testnet: 86_400_000,
};

export function walrusEpochMs(network?: string): number {
  return network && normalizeSuiNetwork(network) === 'testnet'
    ? WALRUS_EPOCH_MS.testnet
    : WALRUS_EPOCH_MS.mainnet;
}
