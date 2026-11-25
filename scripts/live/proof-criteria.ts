/**
 * Pass/fail criteria for the live handoff proof (docs/LIVE_PROOF.md, F1) and the two-account isolation check (F2).
 * Pure functions over collected data, so the criteria are fixed and tested before any live run. Nothing here talks
 * to a network.
 */

export const PROOF_TYPES = ['decision', 'constraint', 'failure'] as const;
export type ProofType = (typeof PROOF_TYPES)[number];

export interface ProofMemory {
  id: string;
  type: string;
  status: string;
  agent: string;
  text: string;
  writeState: string;
  blobId: string | null;
  evidence: { kind: string; [k: string]: unknown }[];
  createdAt: string;
  /** Status-changing events: who moved the memory to confirmed. */
  events: { type: string; actor_kind: string; payload?: Record<string, unknown>; created_at: string }[];
}

export interface ProofRun {
  runId: string;
  startedAt: string;
  /** Unique tokens session A was asked to put in each memory, so session B's use can be found in its transcript. */
  tokens: Record<ProofType, string>;
  /**
   * The network the run was prepared on (Phase 14). Absent in runs saved before Phase 14, which ran on testnet and are
   * judged on testnet.
   */
  network?: 'testnet' | 'mainnet';
  project: { id: string; networks: string[] };
  /** Network the relayer reports on GET /config, read during collect. */
  relayerNetwork: string | null;
  memories: ProofMemory[];
  handoffs: { id: string; agent_slug: string; created_at: string; relied_on: string[] }[];
  /** Memory ids in the briefing session B received (from the dashboard preview of the same task). */
  briefingItemIds: string[];
  transcriptA: string;
  transcriptB: string;
  /** Open flags at the end of the run. */
  flags: { memory_id: string | null; kind: string; state: string }[];
  /** Output of `buiry verify` after the conflicting change, and its exit code. */
  verifyOutput: string;
  verifyExit: number | null;
  /** Result of POST /v1/projects/:id/verifications for the chosen memory. */
  chain: { memoryId: string; result: string; network?: string } | null;
  /** A30: raw recall results from the relayer for the run's queries. */
  scores: {
    query: string;
    /** False when no chain gateway was configured: the relayer then returns no recall results (A23). */
    sealSession?: boolean;
    degraded?: boolean;
    rows: { memoryId: string | null; distance: number | null; score: number | null; lexical: number }[];
  }[];
}

export interface Criterion {
  id: string;
  what: string;
  pass: boolean;
  /** The check could not run (no chain gateway): neither a pass nor evidence of a fault. */
  unknown?: boolean;
  detail: string;
}

/**
 * Environment each live step requires (names only). Only the chain step needs a chain gateway, and it is not
 * required: without one that step reports unknown and every other step still runs (Phase 9 F). The gateway is
 * configured through the chain package's own settings, never named here (Tatum confinement).
 */
export const LIVE_REQUIRED_ENV = {
  prepare: ['BUIRY_PROOF_PROJECT', 'BYO_A_RELAYER_URL'],
  collect: ['BUIRY_API_URL', 'BUIRY_PROOF_TOKEN'],
  verifyChain: ['BUIRY_API_URL', 'BUIRY_PROOF_TOKEN'],
  scores: ['BYO_A_RELAYER_URL', 'BYO_A_ACCOUNT_ID', 'BYO_A_DELEGATE_KEY'],
  isolation: [
    'BYO_A_RELAYER_URL',
    'BYO_A_ACCOUNT_ID',
    'BYO_A_DELEGATE_KEY',
    'BYO_B_RELAYER_URL',
    'BYO_B_ACCOUNT_ID',
    'BYO_B_DELEGATE_KEY',
  ],
  canary: ['BYO_A_RELAYER_URL', 'BYO_A_ACCOUNT_ID', 'BYO_A_DELEGATE_KEY'],
} as const;

const isAgent = (m: ProofMemory, tool: string) => m.agent.startsWith(tool);

/** The three proof memories: one per type, written by session A after the run started, carrying its token. */
export function proofMemories(run: ProofRun): Partial<Record<ProofType, ProofMemory>> {
  const out: Partial<Record<ProofType, ProofMemory>> = {};
  for (const t of PROOF_TYPES) {
    const m = run.memories
      .filter((x) => x.type === t && x.text.includes(run.tokens[t]) && x.createdAt >= run.startedAt)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (m) out[t] = m;
  }
  return out;
}

/** Every criterion, in the order the protocol states them. A run passes only if C1 to C7 all pass. */
export function evaluateProof(run: ProofRun): Criterion[] {
  const pm = proofMemories(run);
  const all = PROOF_TYPES.map((t) => pm[t]);
  const found = all.filter((m): m is ProofMemory => !!m);
  const c: Criterion[] = [];
  // Phase 14: C1 and C7 use the network the run was prepared on; a run saved without one ran on testnet.
  const net = run.network ?? 'testnet';
  const other = net === 'testnet' ? 'mainnet' : 'testnet';

  c.push({
    id: 'C1',
    what: `Real relayer on the run's network (${net}): the project is on sui:${net} only, the relayer reports ${net}, and each proof memory is stored with a blob id`,
    pass:
      run.project.networks.includes(`sui:${net}`) &&
      !run.project.networks.includes(`sui:${other}`) &&
      run.relayerNetwork === net &&
      found.length === 3 &&
      found.every((m) => m.writeState === 'stored' && !!m.blobId),
    detail: `networks ${run.project.networks.join(',')}; relayer ${run.relayerNetwork ?? 'unknown'}; stored ${found.filter((m) => m.writeState === 'stored' && m.blobId).length}/3`,
  });

  c.push({
    id: 'C2',
    what: 'Session A (Claude Code) recorded a decision, a constraint and a failure',
    pass: found.length === 3 && found.every((m) => isAgent(m, 'claude-code')),
    detail: PROOF_TYPES.map((t) => `${t}: ${pm[t] ? `${pm[t]!.id} by ${pm[t]!.agent}` : 'missing'}`).join(
      '; ',
    ),
  });

  const confirmedByPerson = (m: ProofMemory) =>
    m.status === 'confirmed' &&
    m.events.some(
      (e) => e.actor_kind === 'user' && (e.type === 'memory.confirmed' || e.payload?.to === 'confirmed'),
    );
  c.push({
    id: 'C3',
    what: 'A person confirmed all three in the dashboard (status confirmed, the confirming event by a user)',
    pass: found.length === 3 && found.every(confirmedByPerson),
    detail:
      found.map((m) => `${m.id}: ${m.status}${confirmedByPerson(m) ? ' by a person' : ''}`).join('; ') ||
      'none',
  });

  const handoff = run.handoffs
    .filter((h) => h.agent_slug.startsWith('claude-code') && h.created_at >= run.startedAt)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .at(-1);
  c.push({
    id: 'C4',
    what: 'Session A wrote a handoff',
    pass: !!handoff,
    detail: handoff
      ? `${handoff.id} at ${handoff.created_at}`
      : 'no handoff by claude-code since the run started',
  });

  const inBriefing = found.filter((m) => run.briefingItemIds.includes(m.id));
  const usedByB = found.filter(
    (m) => run.transcriptB.includes(m.id) || run.transcriptB.includes(tokenOf(run, m)),
  );
  c.push({
    id: 'C5',
    what: "Session B (OpenCode) received the briefing with all three and its transcript shows it using each (the memory's id or token)",
    pass: found.length === 3 && inBriefing.length === 3 && usedByB.length === 3,
    detail: `in briefing ${inBriefing.length}/3; used in B's transcript ${usedByB.length}/3`,
  });

  const withFile = found.filter((m) => m.evidence.some((e) => e.kind === 'file'));
  const drifted = withFile.filter(
    (m) =>
      run.verifyOutput.includes(`review ${m.id}`) &&
      run.flags.some((f) => f.memory_id === m.id && f.kind === 'needs_review'),
  );
  c.push({
    id: 'C6',
    what: 'After the conflicting change, `buiry verify` lists a proof memory for review and a needs_review flag is open on it',
    pass: drifted.length >= 1 && run.verifyExit === 1,
    detail: `file evidence on ${withFile.length}; flagged ${drifted.map((m) => m.id).join(',') || 'none'}; verify exit ${run.verifyExit ?? 'not run'}`,
  });

  c.push({
    id: 'C7',
    what: `One memory verified against the chain: result pass on sui:${net}. Without a chain gateway the result is unknown: reported as unknown, never as a pass`,
    pass: !!run.chain && run.chain.result === 'pass' && (run.chain.network ?? `sui:${net}`) === `sui:${net}`,
    unknown: !run.chain || run.chain.result === 'unknown',
    detail: run.chain
      ? `${run.chain.memoryId}: ${run.chain.result}${run.chain.network ? ` on ${run.chain.network}` : ''}`
      : 'not run',
  });

  const rows = run.scores.flatMap((s) => s.rows);
  const numeric = rows.filter((r) => r.distance !== null || r.score !== null);
  c.push({
    id: 'C8',
    what: 'A30 recorded: relayer recall results with a numeric distance or score (recorded only; says nothing about ranking)',
    pass: numeric.length > 0,
    detail:
      run.scores.length && run.scores.every((q) => q.sealSession === false)
        ? 'not recordable: no chain gateway, so no Seal session and the relayer returns no recall results (A23)'
        : `${numeric.length} results with a number; ${summarise(rows)}`,
  });
  return c;
}

const tokenOf = (run: ProofRun, m: ProofMemory) => run.tokens[m.type as ProofType] ?? '\u0000';

function summarise(rows: { distance: number | null; score: number | null; lexical: number }[]): string {
  const range = (xs: number[]) =>
    xs.length ? `${Math.min(...xs).toFixed(3)}..${Math.max(...xs).toFixed(3)}` : 'none';
  return `distance ${range(rows.flatMap((r) => (r.distance === null ? [] : [r.distance])))}, score ${range(rows.flatMap((r) => (r.score === null ? [] : [r.score])))}, lexical ${range(rows.map((r) => r.lexical))}`;
}

/** A run passes when C1 to C7 pass; C8 is a record for A30, not a pass condition. */
export function runPassed(c: Criterion[]): boolean {
  return c.filter((x) => x.id !== 'C8').every((x) => x.pass);
}

/**
 * The run's outcome: "passed" (C1 to C7), "passed-chain-unknown" (C1 to C6 pass and the chain step could not run),
 * or "failed". A chain-unknown run never counts as having verified anything on the chain.
 */
export function runOutcome(c: Criterion[]): 'passed' | 'passed-chain-unknown' | 'failed' {
  if (runPassed(c)) return 'passed';
  const c7 = c.find((x) => x.id === 'C7');
  const rest = c.filter((x) => x.id !== 'C7' && x.id !== 'C8');
  return c7?.unknown && rest.every((x) => x.pass) ? 'passed-chain-unknown' : 'failed';
}

/* ---------------- F2: two own accounts stay isolated ---------------- */

export interface IsolationObservation {
  /** Each side's own memory id and blob id. */
  a: { memoryId: string; blobId: string | null };
  b: { memoryId: string; blobId: string | null };
  /** Cross-tenant attempts with each side's agent token: true means it was refused or returned nothing. */
  tokenRefused: { aReadsB: boolean; bReadsA: boolean; aWritesB: boolean; bWritesA: boolean };
  /** Recall and list through Buiry with each side's token, searching for the other side's marker. */
  lookupClean: { aFindsB: boolean; bFindsA: boolean };
  /** Listing each Walrus account directly: which blobs each holds. */
  storage: { aAccountBlobs: string[]; bAccountBlobs: string[] };
}

export function evaluateIsolation(o: IsolationObservation): Criterion[] {
  const stored = !!o.a.blobId && !!o.b.blobId;
  return [
    {
      id: 'I1',
      what: 'Both memories were stored, each with a blob id',
      pass: stored,
      detail: `a ${o.a.blobId ?? 'none'}; b ${o.b.blobId ?? 'none'}`,
    },
    {
      id: 'I2',
      what: "Tokens: neither side's agent token can read or write the other side's project",
      pass: Object.values(o.tokenRefused).every(Boolean),
      detail: JSON.stringify(o.tokenRefused),
    },
    {
      id: 'I3',
      what: "Scoped lookups: recall and list with one side's token never return the other side's memory",
      pass: !o.lookupClean.aFindsB && !o.lookupClean.bFindsA,
      detail: JSON.stringify(o.lookupClean),
    },
    {
      id: 'I4',
      what: "Storage: each blob is listed in its own Walrus account and not in the other's",
      pass:
        stored &&
        o.storage.aAccountBlobs.includes(o.a.blobId!) &&
        !o.storage.aAccountBlobs.includes(o.b.blobId!) &&
        o.storage.bAccountBlobs.includes(o.b.blobId!) &&
        !o.storage.bAccountBlobs.includes(o.a.blobId!),
      detail: `account A lists ${o.storage.aAccountBlobs.length} blobs, account B ${o.storage.bAccountBlobs.length}`,
    },
  ];
}

/**
 * Phase 14: every step after prepare must run with settings that name the network the run was prepared on. A run saved
 * before Phase 14 has no network and was prepared on testnet.
 */
export function preparedNetworkProblem(
  prepared: 'testnet' | 'mainnet' | undefined,
  current: 'testnet' | 'mainnet',
): string | undefined {
  const p = prepared ?? 'testnet';
  return p === current ? undefined : `this run was prepared on ${p}; the settings name ${current}`;
}
