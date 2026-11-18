import { describe, expect, it } from 'vitest';
import { ChainError, degradedOutcome } from '../src/index.js';
import { mapGrpcError } from '../src/tatum/grpc.js';

// Phase 5.4, sweep A7: the gateway's own error text never travels to clients or stored verification results.
const LEAK = 'SECRET-gateway-detail-do-not-leak';

describe('A7: chain gateway error text', () => {
  it('maps gRPC errors to a stable message per status, never the gateway details', () => {
    for (const code of [3, 5, 7, 8, 12, 14, 16, 99]) {
      const e = mapGrpcError({ code, details: `${LEAK} at https://gateway.internal`, message: LEAK });
      expect(e).toBeInstanceOf(ChainError);
      expect(e.message).not.toContain(LEAK);
      expect(e.message).toMatch(/^(gateway returned|gateway rejected the API key)/);
    }
    expect(mapGrpcError({ message: LEAK }).message).toBe('gateway returned no status');
  });

  it('stores a stable verification detail for unexpected errors', () => {
    expect(degradedOutcome(new Error(LEAK))).toEqual({
      result: 'unknown',
      detail: 'verification error',
      degraded: true,
    });
  });
});
