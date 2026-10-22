import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
} from 'node:crypto';

/** Injectable signer so tests (and a future wallet/KMS) never touch key material directly. */
export interface Signer {
  /** Delegate public key, hex (the "agent ID" on Walrus). */
  publicKeyHex: string;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Ed25519 signer from a 32-byte seed (hex). */
export class Ed25519Signer implements Signer {
  readonly publicKeyHex: string;
  private readonly key;

  constructor(seedHex: string) {
    const seed = Buffer.from(seedHex.replace(/^0x/, ''), 'hex');
    if (seed.length !== 32) throw new Error('delegate key must be a 32-byte hex seed');
    this.key = createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
      format: 'der',
      type: 'pkcs8',
    });
    const spki = createPublicKey(this.key).export({ format: 'der', type: 'spki' });
    this.publicKeyHex = Buffer.from(spki).subarray(-32).toString('hex');
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(edSign(null, message, this.key));
  }
}

export function verifyEd25519(publicKeyHex: string, message: Uint8Array, signature: Uint8Array): boolean {
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  const key = createPublicKey({
    key: Buffer.concat([spkiPrefix, Buffer.from(publicKeyHex, 'hex')]),
    format: 'der',
    type: 'spki',
  });
  return edVerify(null, message, key, signature);
}

/** Canonical signed string (ASSUMED, A13). */
export function canonicalRequest(timestamp: string, method: string, path: string, body: string): string {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return `${timestamp}.${method.toUpperCase()}.${path}.${bodyHash}`;
}
