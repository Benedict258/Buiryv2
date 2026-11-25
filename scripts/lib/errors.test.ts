import { describe, expect, it } from 'vitest';
import { RelayerError } from '../../packages/storage/src/index.js';
import { ScriptRefusal, errorText } from './errors.js';
import { relayerNetworkProblem } from './live-guard.js';

// Phase 14b B: a live script's error line names the error class, kind, HTTP status and network cause code, and
// nothing else: never the message (for a relayer error that is the relayer's own response text), a URL, a header or a
// value. Every secret-looking value below is MADE UP.

const net = (code: string) => {
  const e = new RelayerError('unavailable', `relayer unreachable (${code})`);
  e.netCode = code;
  return e;
};

describe('errorText: each kind prints its class, kind and status', () => {
  it.each([
    [new RelayerError('timeout', 'relayer timeout'), 'RelayerError class=timeout kind=timeout'],
    [
      new RelayerError('timeout', 'recall deadline', 504),
      'RelayerError class=timeout kind=timeout status=504',
    ],
    [net('ECONNRESET'), 'RelayerError class=network kind=unavailable cause=ECONNRESET'],
    [new RelayerError('unavailable', 'x', 503), 'RelayerError class=http kind=unavailable status=503'],
    [new RelayerError('auth', 'x', 401), 'RelayerError class=http kind=auth status=401'],
    [new RelayerError('rate_limited', 'x', 429), 'RelayerError class=http kind=rate_limited status=429'],
    [new RelayerError('not_found', 'x', 404), 'RelayerError class=http kind=not_found status=404'],
    [new RelayerError('client', 'x', 409), 'RelayerError class=http kind=client status=409'],
    [new RelayerError('paused', 'x', 503), 'RelayerError class=http kind=paused status=503'],
    [new RelayerError('unknown', 'x', 500), 'RelayerError class=http kind=unknown status=500'],
    [
      new RelayerError('unknown', 'relayer returned non-JSON', 200),
      'RelayerError class=parse kind=unknown status=200',
    ],
    [
      new RelayerError('unknown', 'relayer /config is missing packageId or network'),
      'RelayerError class=invalid-response kind=unknown',
    ],
    [new RelayerError('client', 'bulk too large'), 'RelayerError class=local kind=client'],
  ])('%#', (e, text) => {
    expect(errorText(e)).toBe(text);
  });

  it('prints any other error by its name only, and a script refusal by its own message', () => {
    expect(errorText(new TypeError('fetch failed'))).toBe('TypeError');
    expect(errorText(new Error('x'))).toBe('Error');
    expect(errorText('a thrown string')).toBe('Error');
    expect(errorText(undefined)).toBe('Error');
    expect(errorText(new ScriptRefusal('refusing: the relayer serves testnet, not mainnet'))).toBe(
      'refusing: the relayer serves testnet, not mainnet',
    );
  });
});

describe('errorText never prints a value', () => {
  const SECRETS = [
    'sk-made-up-SECRET-123',
    'made-up-token-456',
    'relayer.example.test',
    'Bearer',
    '0xmadeupkey789',
  ];
  const noSecret = (text: string) => {
    for (const s of SECRETS) expect(text).not.toContain(s);
  };

  it('drops a relayer error message that carries a body, a URL with a query and a header', () => {
    const e = new RelayerError(
      'client',
      'bad request: {"key":"sk-made-up-SECRET-123"} at https://relayer.example.test/api?token=made-up-token-456 authorization: Bearer 0xmadeupkey789',
      400,
    );
    const text = errorText(e);
    expect(text).toBe('RelayerError class=http kind=client status=400');
    noSecret(text);
  });

  it('drops other errors whose message holds a secret, and fields that are not a plain kind, status or code', () => {
    noSecret(errorText(new Error('GET https://relayer.example.test/x?token=made-up-token-456 failed')));
    noSecret(errorText(new SyntaxError('Unexpected token s in {"sk-made-up-SECRET-123"')));
    const forged = Object.assign(new Error('sk-made-up-SECRET-123'), {
      name: 'RelayerError',
      kind: 'client sk-made-up-SECRET-123',
      status: 'made-up-token-456',
      netCode: 'Bearer 0xmadeupkey789',
    });
    const text = errorText(forged);
    expect(text).toBe('RelayerError class=local kind=unrecognised');
    noSecret(text);
    expect(errorText(Object.assign(new Error('x'), { name: 'Error: sk-made-up-SECRET-123' }))).toBe('Error');
  });
});

describe('relayerNetworkProblem names only a recognised network from the response (Phase 14b)', () => {
  it('prints a known network name, and anything else as unrecognised', () => {
    expect(relayerNetworkProblem('testnet', 'mainnet')).toBe('the relayer serves testnet, not mainnet');
    expect(relayerNetworkProblem('sk-made-up-SECRET-123', 'mainnet')).toBe(
      'the relayer serves an unrecognised network, not mainnet',
    );
    expect(relayerNetworkProblem('mainnet', 'mainnet')).toBeUndefined();
  });
});
