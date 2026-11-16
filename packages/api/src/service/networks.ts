import { BuiryError, checkNetworks, projectNetworkConflicts, type NetworkCheck } from '@buiry/core';
import type { Db } from '../db/db.js';
import type { ServiceDeps } from './types.js';

/** The networks this deployment runs on, resolved at startup (shown by `buiry doctor` and the status endpoint). */
export interface RuntimeNetworks {
  /** The agreed Sui network, when the sources name one and agree. */
  sui?: 'mainnet' | 'testnet' | 'devnet';
  walrus?: string;
  tatum?: string;
  relayer?: string;
  demo?: string;
}

/**
 * Compares WALRUS_NETWORK, the effective TATUM_NETWORK, DEMO_NETWORK, the relayer's /config network and every active
 * project's declared Sui networks. The relayer is optional: if its /config cannot be read, the check runs without it.
 */
export async function checkRuntimeNetworks(o: {
  env: Record<string, string | undefined>;
  db: Db;
  gatewayConfigured: boolean;
  relayerConfig?: () => Promise<{ network: string }>;
  warn?: (msg: string) => void;
}): Promise<NetworkCheck & { networks: RuntimeNetworks }> {
  const env = o.env;
  // createGatewayFromEnv defaults TATUM_NETWORK to mainnet when a gateway is configured.
  const tatum = env.TATUM_NETWORK || (o.gatewayConfigured ? 'mainnet' : undefined);
  let relayer: string | undefined;
  if (o.relayerConfig) {
    try {
      relayer = (await o.relayerConfig()).network;
    } catch (e) {
      (o.warn ?? console.warn)(
        `[buiry] could not read the relayer's /config, so its network was not checked: ${(e as Error).message}`,
      );
    }
  }
  const projects = await o.db.system(async (tx) => {
    const r = await tx.query<{ id: string; networks: string[] }>(
      'select id, networks from projects where archived_at is null',
    );
    // A project's own Walrus account is on one Sui network; it must agree with the deployment like any project.
    const own = await tx.query<{ project_id: string; network: string }>(
      'select project_id, network from project_storage',
    );
    return [
      ...r.rows,
      ...own.rows.map((x) => ({
        id: `${x.project_id} (own Walrus account)`,
        networks: [`sui:${x.network}`],
      })),
    ];
  });
  const sources = {
    ...(env.WALRUS_NETWORK ? { walrus: env.WALRUS_NETWORK } : {}),
    ...(tatum ? { tatum } : {}),
    ...(relayer ? { relayer } : {}),
    ...(env.DEMO_NETWORK ? { demo: env.DEMO_NETWORK } : {}),
  };
  const check = checkNetworks({ ...sources, projects });
  return { ...check, networks: { ...sources, ...(check.network ? { sui: check.network } : {}) } };
}

/** Rejects a project network list that names a Sui network other than the deployment's. */
export function assertProjectNetworks(deps: ServiceDeps, networks: string[] | undefined): void {
  const bad = projectNetworkConflicts(networks ?? [], deps.networks?.sui);
  if (bad.length)
    throw new BuiryError(
      'invalid_input',
      `this deployment runs on sui:${deps.networks!.sui}; a project cannot declare ${bad.join(', ')}`,
    );
}
