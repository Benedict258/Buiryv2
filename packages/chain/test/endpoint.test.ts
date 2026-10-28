import { describe, expect, it } from 'vitest';
import { normalizeGrpcEndpoint } from '../src/tatum/grpc.js';

describe('normalizeGrpcEndpoint', () => {
  it('keeps host:port as is (the form Tatum documents)', () => {
    expect(normalizeGrpcEndpoint('sui-mainnet-grpc.gateway.tatum.io:443')).toEqual({
      target: 'sui-mainnet-grpc.gateway.tatum.io:443',
      insecure: false,
    });
  });

  it('turns a gateway URL into host:443 over TLS', () => {
    expect(normalizeGrpcEndpoint('https://example-gateway.gateway.tatum.io/')).toEqual({
      target: 'example-gateway.gateway.tatum.io:443',
      insecure: false,
    });
    expect(normalizeGrpcEndpoint('  sui-mainnet-grpc.gateway.tatum.io  ').target).toBe(
      'sui-mainnet-grpc.gateway.tatum.io:443',
    );
  });

  it('only goes plaintext for an explicit http:// scheme', () => {
    expect(normalizeGrpcEndpoint('http://127.0.0.1:50051')).toEqual({
      target: '127.0.0.1:50051',
      insecure: true,
    });
    expect(normalizeGrpcEndpoint('http://localhost/').target).toBe('localhost:80');
  });

  it('rejects an empty endpoint', () => {
    expect(() => normalizeGrpcEndpoint('https:///')).toThrow(/empty/);
  });
});
