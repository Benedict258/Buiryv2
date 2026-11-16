import { suiNetwork, type GatewayLike } from '@buiry/chain';
import { Ed25519Signer, HttpWalrusAdapter, SealSessionProvider } from '@buiry/storage';

/** One Walrus Memory account: the deployment's managed account, or a project's own (bring your own). */
export interface WalrusAccountConfig {
  relayerUrl: string;
  accountId: string;
  /** Delegate private key (hex seed or suiprivkey). Held in memory only; never logged or returned. */
  delegateKey: string;
}

/**
 * Builds the HTTP adapter for one account. Recall needs a Seal session (A23), whose one Sui read goes through the
 * chain gateway; without a gateway, recall is served from Buiry's index and flagged as cached.
 */
export function buildWalrusAdapter(
  cfg: WalrusAccountConfig,
  gateway?: Pick<GatewayLike, 'getObject'>,
): HttpWalrusAdapter {
  const http = new HttpWalrusAdapter({
    baseUrl: cfg.relayerUrl,
    accountId: cfg.accountId,
    signer: new Ed25519Signer(cfg.delegateKey),
  });
  if (gateway) {
    http.useSealSession(
      new SealSessionProvider({
        delegateKey: cfg.delegateKey,
        relayerConfig: () => http.relayerConfig(),
        packageVersion: async (objectId, network) => {
          const r = await gateway.getObject(objectId, { network: suiNetwork(network) });
          if (!r.value.found) throw new Error('relayer Seal package not found on chain');
          return String(r.value.object.version);
        },
      }),
    );
  }
  return http;
}

/** The public half of a delegate key, or an error that never contains the key. */
export function delegatePublicKey(delegateKey: string): string {
  try {
    return new Ed25519Signer(delegateKey).publicKeyHex;
  } catch {
    throw new Error('delegate key must be 64 hex characters or a suiprivkey1... Ed25519 key');
  }
}
