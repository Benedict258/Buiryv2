import { describe, expect, it } from 'vitest';
import {
  TATUM_MAINNET_GRPC_ENDPOINT,
  createGatewayFromEnv,
  isGatewayConfigured,
  tatumConfigProblems,
  tatumGrpcEndpoint,
} from '../src/index.js';

// Phase 12 B1 and B5: the gateway never defaults to mainnet; the mainnet endpoint is the documented one unless set.
// The key below is made up. Nothing here opens a connection.

const KEY = 'not-a-real-key';

describe('Tatum network is explicit', () => {
  it('refuses to build a gateway when TATUM_NETWORK is unset (no silent mainnet)', () => {
    expect(() => createGatewayFromEnv({ TATUM_API_KEY: KEY, TATUM_GRPC_ENDPOINT: 'h:443' })).toThrow(
      /TATUM_NETWORK is not set/,
    );
    expect(tatumConfigProblems({ TATUM_API_KEY: KEY })).toEqual([
      'TATUM_API_KEY is set but TATUM_NETWORK is not (Buiry never defaults the network)',
    ]);
  });

  it('uses the documented mainnet gRPC endpoint on mainnet unless TATUM_GRPC_ENDPOINT is set', () => {
    expect(TATUM_MAINNET_GRPC_ENDPOINT).toBe('https://sui-mainnet-grpc.gateway.tatum.io');
    expect(tatumGrpcEndpoint({ TATUM_NETWORK: 'mainnet' })).toBe(TATUM_MAINNET_GRPC_ENDPOINT);
    expect(tatumGrpcEndpoint({ TATUM_NETWORK: 'sui:mainnet' })).toBe(TATUM_MAINNET_GRPC_ENDPOINT);
    expect(tatumGrpcEndpoint({ TATUM_NETWORK: 'mainnet', TATUM_GRPC_ENDPOINT: 'other:443' })).toBe(
      'other:443',
    );
    // No endpoint is invented for testnet or devnet.
    expect(tatumGrpcEndpoint({ TATUM_NETWORK: 'testnet' })).toBeUndefined();
    expect(() => createGatewayFromEnv({ TATUM_API_KEY: KEY, TATUM_NETWORK: 'testnet' })).toThrow(
      /TATUM_GRPC_ENDPOINT is not set/,
    );
  });

  it('rejects a TATUM_NETWORK that is not a Sui network', () => {
    expect(() =>
      createGatewayFromEnv({ TATUM_API_KEY: KEY, TATUM_NETWORK: 'sepolia', TATUM_GRPC_ENDPOINT: 'h:443' }),
    ).toThrow(/TATUM_NETWORK=sepolia is not a Sui network/);
  });

  it('answers "configured" without exposing the key', () => {
    expect(isGatewayConfigured({ TATUM_API_KEY: KEY })).toBe(true);
    expect(isGatewayConfigured({ TATUM_API_KEY: '  ' })).toBe(false);
    expect(isGatewayConfigured({})).toBe(false);
  });
});
