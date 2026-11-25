import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWalrusAdapter } from '../src/index.js';

// Phase 14 B: a caller (the read-only calibration script) can turn the adapter's single read retry off. A local stub
// answers every recall with 503 and counts requests; no relayer is contacted. Made-up account and key.

let server: Server;
let base = '';
let recalls = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/api/recall') recalls++;
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unavailable' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const cfg = () => ({ relayerUrl: base, accountId: '0x' + '1'.repeat(64), delegateKey: '22'.repeat(32) });

describe('buildWalrusAdapter read retries', () => {
  it('retries a failed read once by default, and not at all with readRetries 0', async () => {
    recalls = 0;
    await expect(buildWalrusAdapter(cfg()).recall({ namespace: 'ns', query: 'q' })).rejects.toMatchObject({
      kind: 'unavailable',
    });
    expect(recalls).toBe(2);
    recalls = 0;
    await expect(
      buildWalrusAdapter(cfg(), undefined, { readRetries: 0 }).recall({ namespace: 'ns', query: 'q' }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    expect(recalls).toBe(1);
  });
});
