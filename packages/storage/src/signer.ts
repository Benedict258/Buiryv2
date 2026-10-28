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

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32Polymod(values: number[]): number {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= gen[i]!;
  }
  return chk >>> 0;
}

/** Decodes a bech32 string (BIP-173) into its human-readable part and 8-bit data, verifying the checksum. */
export function bech32Decode(s: string): { hrp: string; data: Uint8Array } {
  const str = s.toLowerCase();
  const sep = str.lastIndexOf('1');
  if (sep < 1 || sep + 7 > str.length) throw new Error('invalid bech32 string');
  const hrp = str.slice(0, sep);
  const five = [...str.slice(sep + 1)].map((c) => {
    const v = BECH32_CHARSET.indexOf(c);
    if (v < 0) throw new Error('invalid bech32 character');
    return v;
  });
  const hrpExpanded = [...hrp]
    .map((c) => c.charCodeAt(0) >> 5)
    .concat(
      0,
      [...hrp].map((c) => c.charCodeAt(0) & 31),
    );
  if (bech32Polymod([...hrpExpanded, ...five]) !== 1) throw new Error('invalid bech32 checksum');
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const v of five.slice(0, -6)) {
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
      acc &= (1 << bits) - 1;
    }
  }
  return { hrp, data: Uint8Array.from(out) };
}

/** Accepts a delegate private key as 64 hex chars (optionally 0x-prefixed) or a Sui `suiprivkey1...` string. */
export function parseDelegateKey(input: string): Buffer {
  const k = input.trim();
  if (k.startsWith('suiprivkey')) {
    const { hrp, data } = bech32Decode(k);
    if (hrp !== 'suiprivkey' || data.length !== 33) throw new Error('invalid suiprivkey string');
    if (data[0] !== 0) throw new Error('only Ed25519 (flag 0) suiprivkey keys are supported');
    return Buffer.from(data.subarray(1));
  }
  const seed = Buffer.from(k.replace(/^0x/, ''), 'hex');
  if (seed.length !== 32)
    throw new Error('delegate key must be 64 hex characters or a suiprivkey1... string');
  return seed;
}

/** Ed25519 signer from a 32-byte seed (hex or suiprivkey). */
export class Ed25519Signer implements Signer {
  readonly publicKeyHex: string;
  private readonly key;

  constructor(seedHex: string) {
    const seed = parseDelegateKey(seedHex);
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

/**
 * Canonical signed string, as documented for the Walrus Memory relayer (A13, docs.wal.app relayer
 * api-reference): `{timestamp}.{method}.{path_and_query}.{body_sha256}.{nonce}.{account_id}`.
 * `pathAndQuery` includes the query string. An empty body (GET) hashes the empty string.
 */
export function canonicalRequest(
  timestamp: string,
  method: string,
  pathAndQuery: string,
  body: string,
  nonce: string,
  accountId: string,
): string {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return `${timestamp}.${method.toUpperCase()}.${pathAndQuery}.${bodyHash}.${nonce}.${accountId}`;
}
