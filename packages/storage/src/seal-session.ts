// Seal session for relayer recall (A23).
//
// The relayer decrypts recall results only when the request carries `x-seal-session`: an exported Seal
// `SessionKey` signed by the delegate key. This follows the official SDK (`@mysten-incubation/memwal` 0.1.14,
// `dist/memwal.js`, `buildSealSessionInner`): `SessionKey.create` for the relayer's `packageId`, a 5-minute TTL,
// the delegate keypair as signer, an eager personal-message signature, then `export()` projected into a plain
// object, JSON-encoded and base64-encoded.
//
// Safety:
// - The delegate key and the exported session (which contains an ephemeral session secret) stay in memory only.
//   Nothing here logs, persists or returns them except the header value handed to the adapter.
// - Every error leaving this module is rebuilt with a fixed message plus a scrubbed reason, without `cause`.
// - `SessionKey.create` needs one Sui read (the package object must be version 1). That read is injected
//   (`packageVersion`), so chain access stays in packages/chain; no Sui network client is created here.
import { SessionKey } from '@mysten/seal';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { RelayerError } from './adapter.js';
import { parseDelegateKey } from './signer.js';

/** Seal's documented session lifetime used by the official SDK. */
export const SEAL_SESSION_TTL_MIN = 5;
/** Refresh this long before expiry (the SDK uses 30 s). */
export const SEAL_SESSION_REFRESH_MARGIN_MS = 30_000;

export interface SealSessionSource {
  /** The `x-seal-session` header value. Never log it. */
  header(): Promise<string>;
}

export interface SealSessionOptions {
  /** Delegate private key (64 hex or `suiprivkey1...`). Held in memory only. */
  delegateKey: string;
  /** The relayer's Seal package id and network (from its `GET /config`). */
  relayerConfig: () => Promise<{ packageId: string; network: string }>;
  /** Version of a Sui object, read through the chain gateway. Must resolve to "1" for a first-version package. */
  packageVersion: (objectId: string, network: string) => Promise<string>;
  now?: () => number;
  ttlMin?: number;
  refreshMarginMs?: number;
}

export class SealSessionProvider implements SealSessionSource {
  readonly #keypair: Ed25519Keypair;
  readonly #secrets: string[];
  readonly #o: Required<Omit<SealSessionOptions, 'delegateKey'>>;
  #cache: { value: string; refreshAt: number } | undefined;
  #building: Promise<string> | undefined;
  /** The current session's own secret key (inside the export); scrubbed like the delegate key. */
  #sessionSecret: string | undefined;
  /** Recently replaced sessions and their secrets, still scrubbed from any late error. */
  #retired: string[] = [];

  constructor(o: SealSessionOptions) {
    const seed = parseDelegateKey(o.delegateKey);
    this.#keypair = Ed25519Keypair.fromSecretKey(seed);
    // Strings that must never appear in an error message.
    this.#secrets = [o.delegateKey.trim(), seed.toString('hex'), seed.toString('base64')];
    this.#o = {
      relayerConfig: o.relayerConfig,
      packageVersion: o.packageVersion,
      now: o.now ?? Date.now,
      ttlMin: o.ttlMin ?? SEAL_SESSION_TTL_MIN,
      refreshMarginMs: o.refreshMarginMs ?? SEAL_SESSION_REFRESH_MARGIN_MS,
    };
  }

  async header(): Promise<string> {
    if (this.#cache && this.#o.now() < this.#cache.refreshAt) return this.#cache.value;
    if (this.#building) return this.#building;
    this.#building = this.#build().finally(() => {
      this.#building = undefined;
    });
    return this.#building;
  }

  /** Drop the cached session (for example after the relayer rejects it). */
  invalidate(): void {
    if (this.#cache) this.#retired = [this.#cache.value, ...this.#retired].slice(0, 4);
    if (this.#sessionSecret) this.#retired = [this.#sessionSecret, ...this.#retired].slice(0, 4);
    this.#cache = undefined;
  }

  /** Removes any secret, including the current session, from text that may be logged. */
  scrub(text: string): string {
    let out = text;
    for (const s of [...this.#secrets, this.#cache?.value, this.#sessionSecret, ...this.#retired])
      if (s) out = out.split(s).join('[redacted]');
    return out;
  }

  async #build(): Promise<string> {
    const startedAt = this.#o.now();
    try {
      const cfg = await this.#o.relayerConfig();
      const suiClient = {
        core: {
          getObject: async ({ objectId }: { objectId: string }) => ({
            object: { version: await this.#o.packageVersion(objectId, cfg.network) },
          }),
        },
      };
      const session = await SessionKey.create({
        address: this.#keypair.getPublicKey().toSuiAddress(),
        packageId: cfg.packageId,
        ttlMin: this.#o.ttlMin,
        signer: this.#keypair,
        // Only `core.getObject` is used by `SessionKey.create`; signature checks for Ed25519 are local.
        suiClient: suiClient as unknown as Parameters<typeof SessionKey.create>[0]['suiClient'],
      });
      const { signature } = await this.#keypair.signPersonalMessage(session.getPersonalMessage());
      await session.setPersonalMessageSignature(signature);
      const e = session.export();
      if (this.#cache) this.#retired = [this.#cache.value, ...this.#retired].slice(0, 4);
      if (this.#sessionSecret) this.#retired = [this.#sessionSecret, ...this.#retired].slice(0, 4);
      this.#sessionSecret = e.sessionKey;
      // Seal installs a throwing toJSON on the export; project the fields the relayer imports.
      const value = Buffer.from(
        JSON.stringify({
          address: e.address,
          packageId: e.packageId,
          mvrName: e.mvrName,
          creationTimeMs: e.creationTimeMs,
          ttlMin: e.ttlMin,
          personalMessageSignature: e.personalMessageSignature,
          sessionKey: e.sessionKey,
        }),
        'utf8',
      ).toString('base64');
      this.#cache = { value, refreshAt: startedAt + this.#o.ttlMin * 60_000 - this.#o.refreshMarginMs };
      return value;
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      const kind = err instanceof RelayerError ? err.kind : 'unavailable';
      // Fixed prefix, scrubbed reason, no `cause`: nothing secret can ride along.
      throw new RelayerError(kind, `seal session unavailable: ${this.scrub(reason)}`);
    }
  }
}
