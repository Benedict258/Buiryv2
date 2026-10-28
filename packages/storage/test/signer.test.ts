import { describe, expect, it } from 'vitest';
import { bech32Decode, Ed25519Signer, parseDelegateKey } from '../src/index.js';

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/** Test-only encoder so a suiprivkey string can be built from a known seed. */
function bech32Encode(hrp: string, data: Uint8Array): string {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const polymod = (vals: number[]) => {
    let chk = 1;
    for (const v of vals) {
      const top = chk >>> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= gen[i]!;
    }
    return chk >>> 0;
  };
  const five: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of data) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      five.push((acc >> bits) & 31);
      acc &= (1 << bits) - 1;
    }
  }
  if (bits > 0) five.push((acc << (5 - bits)) & 31);
  const hrpExp = [...hrp]
    .map((c) => c.charCodeAt(0) >> 5)
    .concat(
      0,
      [...hrp].map((c) => c.charCodeAt(0) & 31),
    );
  const mod = polymod([...hrpExp, ...five, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return hrp + '1' + [...five, ...checksum].map((v) => CHARSET[v]).join('');
}

describe('delegate key parsing', () => {
  const seedHex = '11'.repeat(32);

  it('verifies a BIP-173 reference vector checksum', () => {
    expect(bech32Decode('A12UEL5L').hrp).toBe('a');
    expect(() => bech32Decode('A12UEL5M')).toThrow(/checksum/);
  });

  it('accepts 64 hex characters, with or without 0x', () => {
    expect(parseDelegateKey(seedHex).toString('hex')).toBe(seedHex);
    expect(parseDelegateKey('0x' + seedHex).toString('hex')).toBe(seedHex);
  });

  it('accepts a suiprivkey1... string and derives the same signer as the hex seed', () => {
    const sui = bech32Encode('suiprivkey', Buffer.concat([Buffer.from([0]), Buffer.from(seedHex, 'hex')]));
    expect(sui.startsWith('suiprivkey1')).toBe(true);
    expect(new Ed25519Signer(sui).publicKeyHex).toBe(new Ed25519Signer(seedHex).publicKeyHex);
  });

  it('rejects non-Ed25519 suiprivkey flags, bad checksums and wrong lengths', () => {
    const secp = bech32Encode('suiprivkey', Buffer.concat([Buffer.from([1]), Buffer.from(seedHex, 'hex')]));
    expect(() => parseDelegateKey(secp)).toThrow(/Ed25519/);
    const good = bech32Encode('suiprivkey', Buffer.concat([Buffer.from([0]), Buffer.from(seedHex, 'hex')]));
    expect(() => parseDelegateKey(good.slice(0, -1) + (good.endsWith('q') ? 'p' : 'q'))).toThrow(/checksum/);
    expect(() => parseDelegateKey('abcd')).toThrow(/64 hex/);
  });
});
