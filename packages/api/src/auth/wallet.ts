import { createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { blake2b } from '@noble/hashes/blake2.js';

/** Verifies a wallet signature over a plain-language sign-in message. */
export interface WalletVerifier {
  verify(a: { message: string; signature: string; address: string }): boolean | Promise<boolean>;
}

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

function uleb128(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}

const hex = (u: Uint8Array) => '0x' + Buffer.from(u).toString('hex');

/**
 * Sui personal-message verification for Ed25519 keys (ASSUMED scheme, ASSUMPTIONS A20): the wallet signs
 * blake2b-256(intent[3,0,0] || bcs(vec<u8>(message))); the serialized signature is base64(flag || sig(64) || pubkey(32));
 * the address is blake2b-256(flag || pubkey). Other key schemes (secp256k1, secp256r1, zkLogin) are rejected.
 */
export class SuiPersonalMessageVerifier implements WalletVerifier {
  verify({ message, signature, address }: { message: string; signature: string; address: string }): boolean {
    let raw: Buffer;
    try {
      raw = Buffer.from(signature, 'base64');
    } catch {
      return false;
    }
    if (raw.length !== 97 || raw[0] !== 0x00) return false;
    const sig = raw.subarray(1, 65);
    const pk = raw.subarray(65, 97);
    const derived = hex(blake2b(new Uint8Array([0x00, ...pk]), { dkLen: 32 }));
    if (derived.toLowerCase() !== address.toLowerCase()) return false;
    const msg = new TextEncoder().encode(message);
    const digest = blake2b(new Uint8Array([3, 0, 0, ...uleb128(msg.length), ...msg]), { dkLen: 32 });
    try {
      const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, pk]), format: 'der', type: 'spki' });
      return edVerify(null, Buffer.from(digest), key, sig);
    } catch {
      return false;
    }
  }
}

/** Test double: accepts `valid:<address>` signatures only. */
export class FakeWalletVerifier implements WalletVerifier {
  verify({ signature, address }: { message: string; signature: string; address: string }): boolean {
    return signature === `valid:${address}`;
  }
}

/** Builds the sign-in message shown in the wallet (plain language, no transaction). */
export function signInMessage(a: { domain: string; nonce: string; expiresAt: Date }): string {
  return [
    `${a.domain} wants you to sign in to Buiry.`,
    '',
    'This signature proves you control this wallet. It does not move funds or approve a transaction.',
    '',
    `Nonce: ${a.nonce}`,
    `Expires: ${a.expiresAt.toISOString()}`,
  ].join('\n');
}

/** Test helper: produces what a wallet would for the scheme above. */
export function signPersonalMessageForTest(
  privateKey: KeyObject,
  message: string,
): { address: string; signature: string } {
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const pk = spki.subarray(-32);
  const msg = new TextEncoder().encode(message);
  const digest = blake2b(new Uint8Array([3, 0, 0, ...uleb128(msg.length), ...msg]), { dkLen: 32 });
  const sig = edSign(null, Buffer.from(digest), privateKey);
  return {
    address: hex(blake2b(new Uint8Array([0x00, ...pk]), { dkLen: 32 })),
    signature: Buffer.concat([Buffer.from([0x00]), sig, pk]).toString('base64'),
  };
}
