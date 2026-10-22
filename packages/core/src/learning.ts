// SPDX-License-Identifier: Apache-2.0
import type { ActorKind, MemoryRecord, MemoryType, ReportOutcome, Status } from './types.js';
import { similarity } from './similarity.js';

const DAY_MS = 86_400_000;

export interface LearningConfig {
  initialAgent: number;
  humanFloor: number;
  evidenceBoost: number;
  evidenceCap: number;
  helpfulRate: number;
  helpfulMaxPerDay: number;
  agentWeight: number;
  humanWeight: number;
  wrongFactor: number;
  verifyPassRate: number;
  driftFactor: number;
  contestFactor: number;
  /** Half-life in days per memory type. */
  halfLifeDays: Record<MemoryType, number>;
  promotion: { enabled: boolean; helpfulReports: number; distinctSessions: number };
  /** Below this effective confidence a "needs review" flag is raised. */
  reviewThreshold: number;
  conflictThreshold: number;
}

export const DEFAULT_LEARNING: LearningConfig = {
  initialAgent: 0.35,
  humanFloor: 0.8,
  evidenceBoost: 0.25,
  evidenceCap: 0.9,
  helpfulRate: 0.08,
  helpfulMaxPerDay: 2,
  agentWeight: 0.5,
  humanWeight: 1.0,
  wrongFactor: 0.5,
  verifyPassRate: 0.05,
  driftFactor: 0.4,
  contestFactor: 0.7,
  halfLifeDays: {
    handoff: 3,
    task_state: 7,
    deployment: 30,
    fact: 60,
    procedure: 120,
    decision: 180,
    failure: 180,
    constraint: 365,
    preference: 365,
  },
  promotion: { enabled: true, helpfulReports: 3, distinctSessions: 2 },
  reviewThreshold: 0.3,
  conflictThreshold: 0.45,
};

export interface Actor {
  kind: ActorKind;
  /** Agent slug or user id. */
  id: string;
  sessionId?: string;
}

/** Mutable-by-copy learning state of one memory. */
export interface LearningState {
  id: string;
  type: MemoryType;
  status: Status;
  confidence: number;
  lastReinforcedAt: number;
  createdByAgent: string;
  createdBySession?: string;
  helpfulByDay: Record<string, number>;
  /** Helpful reports that count toward auto-promotion (excludes the creating session). */
  promotionSessions: string[];
  promotionReports: number;
  wrongCount: number;
  history: ScoreChange[];
}

export interface ScoreChange {
  at: number;
  signal: string;
  before: number;
  after: number;
  statusBefore: Status;
  statusAfter: Status;
  reason: string;
}

export type Signal =
  | { kind: 'confirm'; actor: Actor }
  | { kind: 'contest'; actor: Actor }
  | { kind: 'report'; actor: Actor; outcome: ReportOutcome }
  | { kind: 'verify'; result: 'pass' | 'fail' }
  | { kind: 'supersede' }
  | { kind: 'tombstone' };

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function initialState(args: {
  id: string;
  type: MemoryType;
  actor: Actor;
  at: number;
  evidenceVerified?: boolean;
  cfg?: LearningConfig;
}): LearningState {
  const cfg = args.cfg ?? DEFAULT_LEARNING;
  const human = args.actor.kind === 'human';
  let c = human ? cfg.humanFloor : cfg.initialAgent;
  if (args.evidenceVerified) c = Math.min(cfg.evidenceCap, c + cfg.evidenceBoost);
  const state: LearningState = {
    id: args.id,
    type: args.type,
    status: human ? 'confirmed' : 'proposed',
    confidence: round4(c),
    lastReinforcedAt: args.at,
    createdByAgent: args.actor.id,
    helpfulByDay: {},
    promotionSessions: [],
    promotionReports: 0,
    wrongCount: 0,
    history: [],
  };
  if (args.actor.sessionId !== undefined) state.createdBySession = args.actor.sessionId;
  return state;
}

export interface SignalResult {
  state: LearningState;
  /** False when the signal was refused (anti-gaming); `reason` explains. */
  applied: boolean;
  reason: string;
}

function commit(
  prev: LearningState,
  next: LearningState,
  at: number,
  signal: string,
  reason: string,
): SignalResult {
  const out: LearningState = {
    ...next,
    confidence: round4(clamp01(next.confidence)),
    history: [
      ...prev.history,
      {
        at,
        signal,
        before: prev.confidence,
        after: round4(clamp01(next.confidence)),
        statusBefore: prev.status,
        statusAfter: next.status,
        reason,
      },
    ],
  };
  return { state: out, applied: true, reason };
}

const refuse = (state: LearningState, reason: string): SignalResult => ({ state, applied: false, reason });

/** Pure transition function. Terminal statuses (superseded, tombstoned) ignore reinforcement. */
export function applySignal(
  s: LearningState,
  signal: Signal,
  at: number,
  cfg: LearningConfig = DEFAULT_LEARNING,
): SignalResult {
  if (s.status === 'superseded' || s.status === 'tombstoned') {
    if (signal.kind !== 'tombstone' && signal.kind !== 'supersede') return refuse(s, `memory is ${s.status}`);
  }
  switch (signal.kind) {
    case 'confirm': {
      if (signal.actor.kind === 'agent') return refuse(s, 'agents cannot confirm memories');
      if (signal.actor.kind === 'system') return refuse(s, 'system cannot confirm memories');
      return commit(
        s,
        {
          ...s,
          status: 'confirmed',
          confidence: Math.max(s.confidence, cfg.humanFloor),
          lastReinforcedAt: at,
        },
        at,
        'confirm',
        'confirmed by a person',
      );
    }
    case 'contest':
      return commit(
        s,
        { ...s, status: 'contested', confidence: s.confidence * cfg.contestFactor },
        at,
        'contest',
        'explicitly contested',
      );
    case 'verify': {
      if (signal.result === 'pass') {
        return commit(
          s,
          { ...s, confidence: s.confidence + (1 - s.confidence) * cfg.verifyPassRate, lastReinforcedAt: at },
          at,
          'verify.pass',
          'evidence re-confirmed',
        );
      }
      return commit(
        s,
        { ...s, status: 'stale', confidence: s.confidence * cfg.driftFactor },
        at,
        'verify.fail',
        'verification detected drift',
      );
    }
    case 'supersede':
      return commit(s, { ...s, status: 'superseded' }, at, 'supersede', 'replaced by a newer memory');
    case 'tombstone':
      return commit(s, { ...s, status: 'tombstoned' }, at, 'tombstone', 'withdrawn from recall');
    case 'report': {
      const human = signal.actor.kind === 'human';
      if (signal.outcome === 'irrelevant') {
        return commit(s, { ...s }, at, 'report.irrelevant', 'reported irrelevant; confidence unchanged');
      }
      if (signal.outcome === 'wrong' || signal.outcome === 'outdated') {
        const wrongCount = s.wrongCount + 1;
        const status: Status = wrongCount >= 2 && s.status !== 'stale' ? 'contested' : s.status;
        return commit(
          s,
          { ...s, wrongCount, status, confidence: s.confidence * cfg.wrongFactor },
          at,
          `report.${signal.outcome}`,
          wrongCount >= 2 ? 'repeated wrong reports; contested' : `reported ${signal.outcome}`,
        );
      }
      // helped
      const day = dayKey(at);
      const used = s.helpfulByDay[day] ?? 0;
      if (used >= cfg.helpfulMaxPerDay) return refuse(s, 'daily reinforcement cap reached');
      const weight = human ? cfg.humanWeight : cfg.agentWeight;
      const next: LearningState = {
        ...s,
        confidence: s.confidence + (1 - s.confidence) * cfg.helpfulRate * weight,
        lastReinforcedAt: at,
        helpfulByDay: { ...s.helpfulByDay, [day]: used + 1 },
      };
      const sid = signal.actor.sessionId;
      const counts =
        !human && sid !== undefined && !(signal.actor.id === s.createdByAgent && sid === s.createdBySession);
      if (counts && sid !== undefined) {
        next.promotionReports = s.promotionReports + 1;
        next.promotionSessions = s.promotionSessions.includes(sid)
          ? s.promotionSessions
          : [...s.promotionSessions, sid];
      }
      let reason = 'reported helpful';
      if (
        cfg.promotion.enabled &&
        next.status === 'proposed' &&
        next.wrongCount === 0 &&
        next.promotionReports >= cfg.promotion.helpfulReports &&
        next.promotionSessions.length >= cfg.promotion.distinctSessions
      ) {
        next.status = 'confirmed';
        next.confidence = Math.max(next.confidence, cfg.humanFloor);
        reason = 'auto-promoted after repeated successful reuse';
      }
      return commit(s, next, at, 'report.helped', reason);
    }
  }
}

/** Decay is applied at read time and never changes status. */
export function effectiveConfidence(
  s: Pick<LearningState, 'confidence' | 'type' | 'lastReinforcedAt'>,
  now: number,
  cfg: LearningConfig = DEFAULT_LEARNING,
): number {
  const dt = Math.max(0, now - s.lastReinforcedAt) / DAY_MS;
  return s.confidence * Math.pow(2, -dt / cfg.halfLifeDays[s.type]);
}

export function needsReview(
  s: Pick<LearningState, 'confidence' | 'type' | 'lastReinforcedAt' | 'status'>,
  now: number,
  cfg: LearningConfig = DEFAULT_LEARNING,
): boolean {
  return (
    s.status !== 'superseded' &&
    s.status !== 'tombstoned' &&
    effectiveConfidence(s, now, cfg) < cfg.reviewThreshold
  );
}

export type ConfidenceBand = 'low' | 'medium' | 'high';
export function confidenceBand(c: number): ConfidenceBand {
  return c < 0.4 ? 'low' : c <= 0.7 ? 'medium' : 'high';
}

// ---------- Conflict candidates ----------

const CONFLICT_TYPES: readonly MemoryType[] = ['decision', 'constraint', 'fact', 'procedure', 'preference'];

export interface ConflictCandidate {
  memoryId: string;
  similarity: number;
  text: string;
}

/** Text-similarity candidates only; never changes status. Superseded/tombstoned memories are skipped. */
export function findConflictCandidates(
  input: { text: string; type: MemoryType },
  existing: Pick<MemoryRecord, 'id' | 'text' | 'type' | 'status'>[],
  cfg: LearningConfig = DEFAULT_LEARNING,
  limit = 5,
): ConflictCandidate[] {
  if (!CONFLICT_TYPES.includes(input.type)) return [];
  return existing
    .filter((m) => CONFLICT_TYPES.includes(m.type) && m.status !== 'superseded' && m.status !== 'tombstoned')
    .map((m) => ({ memoryId: m.id, similarity: round4(similarity(input.text, m.text)), text: m.text }))
    .filter((c) => c.similarity >= cfg.conflictThreshold)
    .sort((a, b) => b.similarity - a.similarity || a.memoryId.localeCompare(b.memoryId))
    .slice(0, limit);
}

// ---------- Failure surfacing ----------

/** Failures similar to the task, most similar first. */
export function surfaceFailures<T extends Pick<MemoryRecord, 'id' | 'text' | 'type' | 'status'>>(
  task: string,
  memories: T[],
  minSimilarity = 0.15,
): { memory: T; similarity: number }[] {
  return memories
    .filter((m) => m.type === 'failure' && m.status !== 'superseded' && m.status !== 'tombstoned')
    .map((memory) => ({ memory, similarity: similarity(task, memory.text) }))
    .filter((x) => x.similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity || a.memory.id.localeCompare(b.memory.id));
}
