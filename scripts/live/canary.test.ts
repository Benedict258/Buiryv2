import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CANARY_MIN_GAP_MS,
  canaryAllowed,
  canaryPass,
  canaryPreflight,
  canaryRecallRecord,
} from './canary-lib.js';

// Phase 10 canary: one write on one account, a single attempt, at most one per hour. Pure part only; no network.

describe('canary pacing', () => {
  it('runs when there was no canary, refuses within the hour, and runs again after it', () => {
    const now = Date.parse('2026-11-23T12:00:00Z');
    expect(CANARY_MIN_GAP_MS).toBe(60 * 60_000);
    expect(canaryAllowed(null, now)).toEqual({ ok: true });
    expect(canaryAllowed('2026-11-23T11:30:00Z', now)).toEqual({ ok: false, waitMinutes: 30 });
    expect(canaryAllowed('2026-11-23T11:00:00Z', now)).toEqual({ ok: true });
    expect(canaryAllowed('not a time', now)).toEqual({ ok: false, waitMinutes: 60 }); // unreadable: refuse, safe side
  });
});

// Phase 12 C: the canary obeys the network rules before anything else, prints its network first, and on mainnet
// needs the opt-in. Made-up values only; nothing here opens a connection.
describe('canary preflight (Phase 12)', () => {
  const MAIN = 'https://relayer.memory.walrus.xyz';
  const STAGING = 'https://relayer-staging.memory.walrus.xyz';
  const acct = { BYO_A_ACCOUNT_ID: '0xa', BYO_A_DELEGATE_KEY: 'made-up' };
  const gw = { gatewayConfigured: true };

  it('refuses a relayer host that does not match the network', () => {
    const r = canaryPreflight(
      { ...acct, BYO_A_RELAYER_URL: MAIN, WALRUS_NETWORK: 'testnet', TATUM_NETWORK: 'testnet' },
      gw,
    );
    expect(r).toMatchObject({ ok: false, exitCode: 64 });
    if (!r.ok) expect(r.message).toMatch(/^refused: network settings: .*networks disagree/);
  });

  it('refuses mainnet without BUIRY_ALLOW_MAINNET=1', () => {
    const env = { ...acct, BYO_A_RELAYER_URL: MAIN, WALRUS_NETWORK: 'mainnet', TATUM_NETWORK: 'mainnet' };
    const r = canaryPreflight(env, gw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/mainnet is refused without BUIRY_ALLOW_MAINNET=1/);
    expect(canaryPreflight({ ...env, BUIRY_ALLOW_MAINNET: '1' }, gw)).toEqual({
      ok: true,
      network: 'mainnet',
      firstLine: 'network mainnet (relayer relayer.memory.walrus.xyz)',
    });
  });

  it('refuses when the chain gateway is not configured (no Seal session, so no real recall)', () => {
    const r = canaryPreflight(
      { ...acct, BYO_A_RELAYER_URL: STAGING, WALRUS_NETWORK: 'testnet' },
      { gatewayConfigured: false },
    );
    expect(r).toMatchObject({ ok: false, exitCode: 64 });
    if (!r.ok) expect(r.message).toMatch(/chain gateway is not configured/);
  });

  it('refuses missing account settings, naming them only', () => {
    const r = canaryPreflight({ WALRUS_NETWORK: 'testnet' }, gw);
    expect(r).toMatchObject({ ok: false, exitCode: 64 });
    if (!r.ok)
      expect(r.message).toBe(
        'missing: BYO_A_RELAYER_URL, BYO_A_ACCOUNT_ID, BYO_A_DELEGATE_KEY (names only; see docs/LIVE_PROOF.md)',
      );
  });
});

describe('canary script shape (Phase 12 C)', () => {
  const src = readFileSync(fileURLToPath(new URL('./canary.ts', import.meta.url)), 'utf8');
  it('makes exactly one write, outside any loop, after the hourly slot is taken', () => {
    expect(src.match(/\.remember\(/g)).toHaveLength(1);
    const write = src.indexOf('.remember(');
    expect(src.indexOf('writeFileSync(LAST')).toBeLessThan(write);
    expect(src.slice(0, write)).not.toMatch(/\b(for|while)\s*\(/);
  });
  it('runs the network preflight before anything else and prints the network first', () => {
    const first = src.indexOf('canaryPreflight(');
    expect(first).toBeGreaterThan(0);
    for (const later of ['canaryAllowed(', 'buildWalrusAdapter(', 'createGatewayIfConfigured(', 'say('])
      expect(src.indexOf(later), later).toBeGreaterThan(first);
    expect(src).toMatch(/say\(`\$\{utc\(\)\} \$\{pre\.firstLine\}/);
    expect(src).toMatch(/conf\.network !== pre\.network/);
  });
});

// Phase 13: PASS = the job completes with a blob id, a recall returns that memory, and its raw distance is recorded.
// No relayer score is required: the relayer returns one only when scoring_weights is sent, and Buiry does not send it.
describe('canary pass criteria and recall record (Phase 13)', () => {
  const text = 'Buiry canary abc123: a one-line test memory.';
  const results = [
    { blobId: 'b-other', text: 'another memory', distance: 0.6, fields: ['blob_id', 'distance', 'text'] },
    { blobId: 'b-1', text, distance: 0.0000149, fields: ['blob_id', 'distance', 'text'] },
  ];

  it('records field names and raw distances per result, the hit, and never memory text', () => {
    const rec = canaryRecallRecord({ results, degraded: false }, text);
    expect(rec).toEqual({
      results: 2,
      degraded: false,
      found: true,
      hitDistance: 0.0000149,
      hitScore: null,
      perResult: [
        { fields: ['blob_id', 'distance', 'text'], distance: 0.6 },
        { fields: ['blob_id', 'distance', 'text'], distance: 0.0000149 },
      ],
    });
    expect(JSON.stringify(rec)).not.toContain('memory');
    expect(canaryRecallRecord({ results: [results[0]!] }, text)).toMatchObject({
      found: false,
      hitDistance: null,
    });
  });

  it('passes on blob id, recall found and a recorded distance; a score is not required', () => {
    const recall = canaryRecallRecord({ results }, text);
    expect(canaryPass({ final: 'done', blobId: 'b-1', recall })).toBe(true);
    expect(canaryPass({ final: 'done', recall })).toBe(false);
    expect(canaryPass({ final: 'done', blobId: '', recall })).toBe(false);
    expect(canaryPass({ final: 'failed', blobId: 'b-1', recall })).toBe(false);
    expect(canaryPass({ final: 'done', blobId: 'b-1' })).toBe(false);
    expect(canaryPass({ final: 'done', blobId: 'b-1', recall: { ...recall, found: false } })).toBe(false);
    expect(canaryPass({ final: 'done', blobId: 'b-1', recall: { ...recall, hitDistance: null } })).toBe(
      false,
    );
  });

  it('the script saves the blob id from the finished job and judges with canaryPass and canaryRecallRecord', () => {
    const src = readFileSync(fileURLToPath(new URL('./canary.ts', import.meta.url)), 'utf8');
    expect(src).toContain('result.blobId = st.blobId');
    expect(src).toContain('canaryRecallRecord(');
    expect(src).toContain('result.pass = canaryPass(');
    expect(src).not.toContain("result.pass = final === 'done' && result.recallFound");
  });
});
