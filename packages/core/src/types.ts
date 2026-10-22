// SPDX-License-Identifier: Apache-2.0

export const MEMORY_TYPES = [
  'decision',
  'constraint',
  'fact',
  'failure',
  'procedure',
  'preference',
  'task_state',
  'deployment',
  'handoff',
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const STATUSES = ['proposed', 'confirmed', 'contested', 'stale', 'superseded', 'tombstoned'] as const;
export type Status = (typeof STATUSES)[number];

export type Evidence =
  | { kind: 'tx'; digest: string; network: string }
  | { kind: 'object'; id: string; version?: string; network: string }
  | { kind: 'package'; id: string; network: string }
  | { kind: 'file'; path: string; commit?: string }
  | { kind: 'url'; href: string }
  | { kind: 'test'; name: string; result: 'pass' | 'fail' };

export type EvidenceKind = Evidence['kind'];

/** Tier A events are written to Walrus. */
export const TIER_A_EVENTS = [
  'memory.created',
  'memory.confirmed',
  'memory.contested',
  'memory.superseded',
  'memory.stale',
  'memory.tombstoned',
  'memory.snapshot',
  'handoff.created',
  'branch.merged',
] as const;
export type TierAEvent = (typeof TIER_A_EVENTS)[number];

/** Tier B events stay in Buiry's database. */
export const TIER_B_EVENTS = ['memory.reported', 'memory.validated', 'memory.recalled'] as const;
export type TierBEvent = (typeof TIER_B_EVENTS)[number];

export type EventType = TierAEvent | TierBEvent;

export function eventTier(evt: EventType): 'A' | 'B' {
  return (TIER_A_EVENTS as readonly string[]).includes(evt) ? 'A' : 'B';
}

export type ReportOutcome = 'helped' | 'wrong' | 'irrelevant' | 'outdated';

export type ActorKind = 'human' | 'agent' | 'system';

/** Derived read model of one memory (epoch-millisecond timestamps). */
export interface MemoryRecord {
  id: string;
  branch: string;
  type: MemoryType;
  status: Status;
  text: string;
  /** Stored (undecayed) confidence in [0, 1]. */
  confidence: number;
  agent: string;
  createdAt: number;
  updatedAt: number;
  /** Last reinforcing event; decay is measured from here. */
  lastReinforcedAt: number;
  evidence: Evidence[];
  supersedesId?: string;
  supersededById?: string;
  expired?: boolean;
  expiresAt?: number;
  flags?: string[];
}
