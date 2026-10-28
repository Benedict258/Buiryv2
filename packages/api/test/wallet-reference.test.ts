import { describe, expect, it } from 'vitest';
import { SuiPersonalMessageVerifier } from '../src/index.js';

/**
 * Cross-implementation vector (A20). The signature was produced by Mysten's official SDK
 * (@mysten/sui 2.38.0, Ed25519Keypair.signPersonalMessage) from a throwaway test seed, not by this
 * repository's own signer, so it checks the verifier against the reference implementation.
 */
const VECTOR = {
  address: '0xa0ccc8bcc83f6c628340134f8546a21e0618fd1aaa02432bba454c4a2c2233da',
  message:
    'localhost:8787 wants you to sign in to Buiry.\n\nNonce: 0123456789abcdef0123456789abcdef\nExpires: 2026-10-28T16:00:00.000Z',
  signature:
    'AEFbtLDcYvJ9IMklcFJKRGSFvU5cJEqLeNwngbOisSxjF6WI3OGC4aUbMhRFWGPlD6l0MWsEYZedQGiD1N2uMA7qSmxj4pxSCr71UHsTLsX5lUd2rr6+e5JCHuppFEbSLA==',
};

describe('SuiPersonalMessageVerifier against the official SDK', () => {
  const v = new SuiPersonalMessageVerifier();

  it('accepts a signature produced by the reference implementation', () => {
    expect(v.verify(VECTOR)).toBe(true);
  });

  it('rejects a changed message, another address and a corrupted signature', () => {
    expect(v.verify({ ...VECTOR, message: VECTOR.message.replace('0123', '9999') })).toBe(false);
    expect(v.verify({ ...VECTOR, address: '0x' + 'ab'.repeat(32) })).toBe(false);
    const sig = Buffer.from(VECTOR.signature, 'base64');
    sig[10] = (sig[10]! + 1) % 256;
    expect(v.verify({ ...VECTOR, signature: sig.toString('base64') })).toBe(false);
  });
});
