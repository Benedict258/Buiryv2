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

/**
 * The hosted Walrus Memory relayers and the network each serves (Phase 12, BD48). relayer.memory.walrus.xyz
 * ("Production (Mainnet)") and relayer.dev.memwal.ai ("Staging (Testnet)") are listed on
 * https://docs.wal.app/walrus-memory/relayer/public-relayer; relayer-staging.memory.walrus.xyz comes from the owner's
 * brief and is not on Walrus's pages (UNVERIFIED, A31). Any other host is refused unless WALRUS_RELAYER_NETWORK names
 * the network it serves.
 */
export const HOSTED_RELAYER_HOSTS: Readonly<Record<string, 'mainnet' | 'testnet'>> = {
  'relayer.memory.walrus.xyz': 'mainnet',
  'relayer.dev.memwal.ai': 'testnet',
  'relayer-staging.memory.walrus.xyz': 'testnet',
};

/** The opt-in without which mainnet is refused everywhere. */
export const ALLOW_MAINNET_VAR = 'BUIRY_ALLOW_MAINNET';
/** Names the network served by a relayer host Buiry does not recognise (self-hosted, local, mock). */
export const RELAYER_NETWORK_VAR = 'WALRUS_RELAYER_NETWORK';

function relayerHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** The network a hosted relayer URL serves, or undefined for any other host or an unparseable URL. */
export function relayerHostNetwork(url: string): 'mainnet' | 'testnet' | undefined {
  const host = relayerHost(url);
  return host ? HOSTED_RELAYER_HOSTS[host] : undefined;
}

export interface NetworkEnvOptions {
  /** True when something live is configured or the deployment is production or preview: a network must be named. */
  requireNetwork: boolean;
  /** The chain package's own "configured" check (the key is never read outside packages/chain). */
  gatewayConfigured: boolean;
}

export interface NetworkEnvCheck {
  /** The agreed network; set only when there are no problems. */
  network?: SuiNetworkName;
  /** One sentence per problem, naming variables and relayer hosts only. Empty when the settings may be used. */
  problems: string[];
}

/**
 * Phase 12 B: the deployment's network comes from explicit settings only, never a default. WALRUS_NETWORK,
 * TATUM_NETWORK, DEMO_NETWORK, WALRUS_RELAYER_NETWORK and the host of every `*_RELAYER_URL` must agree; an
 * unrecognised relayer host needs WALRUS_RELAYER_NETWORK; mainnet needs BUIRY_ALLOW_MAINNET=1. Pure.
 */
export function checkNetworkEnv(
  env: Record<string, string | undefined>,
  o: NetworkEnvOptions,
): NetworkEnvCheck {
  const problems: string[] = [];
  const val = (k: string) => env[k]?.trim() || undefined;
  const named: { label: string; net: SuiNetworkName }[] = [];
  const add = (label: string, raw: string) => {
    const net = normalizeSuiNetwork(raw);
    if (net) named.push({ label, net });
    else problems.push(`${label}=${raw} is not a Sui network (mainnet, testnet or devnet)`);
  };
  for (const k of ['WALRUS_NETWORK', 'TATUM_NETWORK', 'DEMO_NETWORK', RELAYER_NETWORK_VAR]) {
    const v = val(k);
    if (v) add(k, v);
  }
  const relayers = Object.keys(env)
    .filter((k) => /_RELAYER_URL$/.test(k) && val(k))
    .sort((a, b) => (a === 'WALRUS_RELAYER_URL' ? -1 : b === 'WALRUS_RELAYER_URL' ? 1 : a.localeCompare(b)));
  for (const k of relayers) {
    const host = relayerHost(val(k)!);
    if (!host) {
      problems.push(`${k} is not a URL`);
      continue;
    }
    const hosted = HOSTED_RELAYER_HOSTS[host];
    if (hosted) named.push({ label: `${k} host ${host}`, net: hosted });
    else if (!val(RELAYER_NETWORK_VAR))
      problems.push(
        `${k} host ${host} is not a hosted Walrus Memory relayer (relayer.memory.walrus.xyz serves mainnet; relayer.dev.memwal.ai and relayer-staging.memory.walrus.xyz serve testnet); set ${RELAYER_NETWORK_VAR} to the network it serves`,
      );
  }
  if (relayers.length && !val('WALRUS_NETWORK'))
    problems.push('WALRUS_NETWORK is not set: a relayer URL is configured, so its network must be named');
  if (o.gatewayConfigured && !val('TATUM_NETWORK'))
    problems.push('TATUM_NETWORK is not set: the chain gateway is configured, so its network must be named');

  const distinct = [...new Set(named.map((n) => n.net))];
  if (distinct.length > 1)
    problems.push(`networks disagree: ${named.map((n) => `${n.label}=${n.net}`).join(', ')}`);
  if (o.requireNetwork && named.length === 0)
    problems.push(
      'no network is set: set WALRUS_NETWORK (and TATUM_NETWORK) to testnet or mainnet; Buiry never picks one by default',
    );
  const network = distinct.length === 1 ? distinct[0] : undefined;
  if (network === 'mainnet' && val(ALLOW_MAINNET_VAR) !== '1')
    problems.push(`mainnet is refused without ${ALLOW_MAINNET_VAR}=1 (an explicit opt-in)`);
  return { ...(network && problems.length === 0 ? { network } : {}), problems };
}
