import { describe, expect, it } from 'vitest';
import {
  LIVE_REQUIRED_ENV,
  preparedNetworkProblem,
  runOutcome,
  evaluateIsolation,
  evaluateProof,
  runPassed,
  type ProofMemory,
  type ProofRun,
  type IsolationObservation,
} from './proof-criteria.js';

// The F1 and F2 pass/fail rules, fixed before any live run. Every value below is MADE UP for the test: these are
// not live results.

const T0 = '2026-11-22T10:00:00.000Z';
const mem = (id: string, type: string, token: string, o: Partial<ProofMemory> = {}): ProofMemory => ({
  id,
  type,
  status: 'confirmed',
  agent: 'claude-code-1a2b',
  text: `${type} ${token}`,
  writeState: 'stored',
  blobId: `blob_${id}`,
  evidence: type === 'constraint' ? [{ kind: 'file', path: 'src/session.ts', commit: 'abc1234' }] : [],
  createdAt: '2026-11-22T10:05:00.000Z',
  events: [{ type: 'memory.confirmed', actor_kind: 'user', created_at: '2026-11-22T10:20:00.000Z' }],
  ...o,
});
const passing = (): ProofRun => ({
  runId: 'run-1',
  startedAt: T0,
  tokens: { decision: 'PROOF-DEC-1', constraint: 'PROOF-CON-1', failure: 'PROOF-FAIL-1' },
  project: { id: 'prj_X', networks: ['sui:testnet'] },
  relayerNetwork: 'testnet',
  memories: [
    mem('mem_d', 'decision', 'PROOF-DEC-1'),
    mem('mem_c', 'constraint', 'PROOF-CON-1'),
    mem('mem_f', 'failure', 'PROOF-FAIL-1'),
  ],
  handoffs: [
    { id: 'hof_1', agent_slug: 'claude-code-1a2b', created_at: '2026-11-22T10:30:00.000Z', relied_on: [] },
  ],
  briefingItemIds: ['mem_d', 'mem_c', 'mem_f'],
  transcriptA: '',
  transcriptB: 'Following PROOF-DEC-1 and constraint mem_c; avoiding the failure PROOF-FAIL-1.',
  flags: [{ memory_id: 'mem_c', kind: 'needs_review', state: 'open' }],
  verifyOutput: 'Checked 1 memories: 0 files unchanged, 1 changed.\n  review mem_c: src/session.ts changed',
  verifyExit: 1,
  chain: { memoryId: 'mem_d', result: 'pass', network: 'sui:testnet' },
  scores: [
    { query: 'session storage', rows: [{ memoryId: 'mem_d', distance: 0.31, score: null, lexical: 0.5 }] },
  ],
});
const failed = (r: ProofRun) =>
  evaluateProof(r)
    .filter((c) => !c.pass)
    .map((c) => c.id);

describe('F1 handoff proof criteria (made-up data)', () => {
  it('a complete run passes every criterion', () => {
    expect(failed(passing())).toEqual([]);
    expect(runPassed(evaluateProof(passing()))).toBe(true);
  });

  it('C1 fails on mainnet, an unknown relayer network or an unstored memory', () => {
    expect(
      failed({ ...passing(), project: { id: 'p', networks: ['sui:mainnet', 'sui:testnet'] } }),
    ).toContain('C1');
    expect(failed({ ...passing(), relayerNetwork: null })).toContain('C1');
    const r = passing();
    r.memories[0] = { ...r.memories[0]!, writeState: 'queued', blobId: null };
    expect(failed(r)).toContain('C1');
  });

  it('C2 fails when a type is missing or another tool wrote it', () => {
    const r = passing();
    r.memories = r.memories.slice(1);
    expect(failed(r)).toContain('C2');
    const s = passing();
    s.memories[2] = { ...s.memories[2]!, agent: 'opencode-77' };
    expect(failed(s)).toContain('C2');
  });

  it('C3 fails unless a person confirmed each one', () => {
    const r = passing();
    r.memories[1] = {
      ...r.memories[1]!,
      events: [{ type: 'memory.confirmed', actor_kind: 'agent', created_at: T0 }],
    };
    expect(failed(r)).toContain('C3');
    const s = passing();
    s.memories[0] = { ...s.memories[0]!, status: 'proposed', events: [] };
    expect(failed(s)).toContain('C3');
  });

  it('C4 fails without a handoff from session A after the start', () => {
    expect(failed({ ...passing(), handoffs: [] })).toContain('C4');
    expect(
      failed({
        ...passing(),
        handoffs: [
          { id: 'h', agent_slug: 'claude-code-1a2b', created_at: '2026-11-21T00:00:00Z', relied_on: [] },
        ],
      }),
    ).toContain('C4');
  });

  it("C5 fails when an item is missing from the briefing or unused in B's transcript", () => {
    expect(failed({ ...passing(), briefingItemIds: ['mem_d', 'mem_c'] })).toContain('C5');
    expect(failed({ ...passing(), transcriptB: 'I read the briefing.' })).toContain('C5');
  });

  it('C6 fails without the review line, the flag, or a non-zero exit', () => {
    expect(failed({ ...passing(), flags: [] })).toContain('C6');
    expect(
      failed({
        ...passing(),
        verifyOutput: 'Checked 1 memories: 1 files unchanged, 0 changed.',
        verifyExit: 0,
      }),
    ).toContain('C6');
  });

  it('C7 fails on unknown (no gateway) or a mainnet check', () => {
    expect(failed({ ...passing(), chain: { memoryId: 'mem_d', result: 'unknown' } })).toContain('C7');
    expect(
      failed({ ...passing(), chain: { memoryId: 'mem_d', result: 'pass', network: 'sui:mainnet' } }),
    ).toContain('C7');
    expect(failed({ ...passing(), chain: null })).toContain('C7');
  });

  it('C8 records A30 scores but never decides the run', () => {
    const r = { ...passing(), scores: [] };
    expect(failed(r)).toEqual(['C8']);
    expect(runPassed(evaluateProof(r))).toBe(true);
  });
});

describe('F2 isolation criteria (made-up data)', () => {
  const ok: IsolationObservation = {
    a: { memoryId: 'mem_a', blobId: 'blob_a' },
    b: { memoryId: 'mem_b', blobId: 'blob_b' },
    tokenRefused: { aReadsB: true, bReadsA: true, aWritesB: true, bWritesA: true },
    lookupClean: { aFindsB: false, bFindsA: false },
    storage: { aAccountBlobs: ['blob_a'], bAccountBlobs: ['blob_b'] },
  };
  const bad = (o: IsolationObservation) =>
    evaluateIsolation(o)
      .filter((c) => !c.pass)
      .map((c) => c.id);
  it('isolated accounts pass', () => expect(bad(ok)).toEqual([]));
  it('any crossing fails its criterion', () => {
    expect(bad({ ...ok, tokenRefused: { ...ok.tokenRefused, aReadsB: false } })).toEqual(['I2']);
    expect(bad({ ...ok, lookupClean: { aFindsB: true, bFindsA: false } })).toEqual(['I3']);
    expect(
      bad({ ...ok, storage: { aAccountBlobs: ['blob_a', 'blob_b'], bAccountBlobs: ['blob_b'] } }),
    ).toEqual(['I4']);
    expect(bad({ ...ok, b: { memoryId: 'mem_b', blobId: null } })).toEqual(['I1', 'I4']);
  });
});

describe('the live steps do not need a chain gateway (Phase 9 F)', () => {
  it('no step requires a chain or gateway setting; only the chain step uses one, when configured', () => {
    for (const [step, names] of Object.entries(LIVE_REQUIRED_ENV))
      for (const n of names) expect(n, step).not.toMatch(/TATUM|GATEWAY|GRPC/i);
  });

  it('without a gateway the chain step is unknown, not failed, and the run is passed-chain-unknown', () => {
    const r = { ...passing(), chain: { memoryId: 'mem_d', result: 'unknown' } };
    const c7 = evaluateProof(r).find((c) => c.id === 'C7')!;
    expect(c7.pass).toBe(false);
    expect(c7.unknown).toBe(true);
    expect(runOutcome(evaluateProof(r))).toBe('passed-chain-unknown');
    expect(runOutcome(evaluateProof(passing()))).toBe('passed');
  });

  it('a chain-unknown run still fails when anything else fails', () => {
    const r = { ...passing(), chain: null, flags: [] };
    expect(runOutcome(evaluateProof(r))).toBe('failed');
  });

  it('a real chain failure is a failure, not unknown', () => {
    const r = { ...passing(), chain: { memoryId: 'mem_d', result: 'fail', network: 'sui:testnet' } };
    expect(evaluateProof(r).find((c) => c.id === 'C7')!.unknown).toBe(false);
    expect(runOutcome(evaluateProof(r))).toBe('failed');
  });

  it('without a Seal session, C8 says the scores could not be recorded', () => {
    const r = { ...passing(), scores: [{ query: 'q', sealSession: false, degraded: true, rows: [] }] };
    expect(evaluateProof(r).find((c) => c.id === 'C8')!.detail).toMatch(/not recordable: no chain gateway/);
  });
});

// Phase 14 (owner's decision): C1 and C7 check the network the run was prepared on, saved with the run. A run saved
// before Phase 14 has no network field and is judged on testnet, exactly as before.
describe('F1 criteria on the run network (Phase 14)', () => {
  const mainnetRun = (): ProofRun => ({
    ...passing(),
    network: 'mainnet',
    project: { id: 'prj_X', networks: ['sui:mainnet'] },
    relayerNetwork: 'mainnet',
    chain: { memoryId: 'mem_d', result: 'pass', network: 'sui:mainnet' },
  });

  it('a complete mainnet run passes every criterion, and a testnet run without a network field still passes', () => {
    expect(failed(mainnetRun())).toEqual([]);
    expect(passing().network).toBeUndefined();
    expect(failed(passing())).toEqual([]);
    expect(failed({ ...passing(), network: 'testnet' })).toEqual([]);
  });

  it('C1 fails a mainnet run on a testnet project, a testnet relayer, or a project on both networks', () => {
    expect(failed({ ...mainnetRun(), project: { id: 'p', networks: ['sui:testnet'] } })).toContain('C1');
    expect(failed({ ...mainnetRun(), relayerNetwork: 'testnet' })).toContain('C1');
    expect(
      failed({ ...mainnetRun(), project: { id: 'p', networks: ['sui:mainnet', 'sui:testnet'] } }),
    ).toContain('C1');
    expect(failed({ ...passing(), relayerNetwork: 'mainnet' })).toContain('C1');
  });

  it('C7 fails a chain check on the other network', () => {
    expect(
      failed({ ...mainnetRun(), chain: { memoryId: 'mem_d', result: 'pass', network: 'sui:testnet' } }),
    ).toContain('C7');
    expect(
      failed({ ...passing(), chain: { memoryId: 'mem_d', result: 'pass', network: 'sui:mainnet' } }),
    ).toContain('C7');
  });

  it('refuses a later step whose settings name another network than the run was prepared on', () => {
    expect(preparedNetworkProblem('mainnet', 'mainnet')).toBeUndefined();
    expect(preparedNetworkProblem(undefined, 'testnet')).toBeUndefined();
    expect(preparedNetworkProblem(undefined, 'mainnet')).toBe(
      'this run was prepared on testnet; the settings name mainnet',
    );
    expect(preparedNetworkProblem('mainnet', 'testnet')).toBe(
      'this run was prepared on mainnet; the settings name testnet',
    );
  });

  it('the proof account is tester A (BYO_A_*), as on testnet where it is the same account', () => {
    expect(LIVE_REQUIRED_ENV.prepare).toEqual(['BUIRY_PROOF_PROJECT', 'BYO_A_RELAYER_URL']);
    expect(LIVE_REQUIRED_ENV.scores).toEqual(['BYO_A_RELAYER_URL', 'BYO_A_ACCOUNT_ID', 'BYO_A_DELEGATE_KEY']);
  });
});
