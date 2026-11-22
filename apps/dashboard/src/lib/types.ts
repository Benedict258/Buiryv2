export type Status = 'proposed' | 'confirmed' | 'contested' | 'stale' | 'superseded' | 'tombstoned';
export type MemType =
  | 'decision'
  | 'constraint'
  | 'fact'
  | 'failure'
  | 'procedure'
  | 'preference'
  | 'task_state'
  | 'deployment'
  | 'handoff';
export const MEM_TYPES: MemType[] = [
  'decision',
  'constraint',
  'fact',
  'failure',
  'procedure',
  'preference',
  'task_state',
  'deployment',
  'handoff',
];
export const STATUSES: Status[] = ['proposed', 'confirmed', 'contested', 'stale', 'superseded', 'tombstoned'];

export interface Evidence {
  kind: string;
  [k: string]: unknown;
}
export interface Me {
  id: string;
  email: string | null;
  displayName: string | null;
  identities: { provider: string; subject: string }[];
  workspaces: { id: string; name: string; role: Role; plan: string; projects?: number }[];
}
export type Role = 'reader' | 'writer' | 'admin' | 'owner';
export interface ProjectCard {
  id: string;
  name: string;
  networks: string[];
  walrusMode: string;
  createdAt: string;
  archivedAt: string | null;
  memories: number;
  openFlags: number;
  agents: number;
  lastActivity: string | null;
  expiring: number;
}
export interface Memory {
  id: string;
  type: MemType;
  status: Status;
  text: string;
  confidence: number;
  effectiveConfidence: number;
  agent: string;
  branch: string;
  evidence: Evidence[];
  evidenceResults: string[];
  flags: string[];
  writeState: 'queued' | 'stored' | 'failed';
  blobId: string | null;
  expiresAt: string | null;
  expired: boolean;
  supersedesId: string | null;
  supersededById: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface MemoryEvent {
  id: string;
  tier: string;
  type: string;
  payload: Record<string, unknown>;
  actor_kind: string;
  actor_id: string | null;
  created_at: string;
  walrus_blob_id?: string | null;
}
export interface MemoryDetail {
  memoryId: string;
  text: string;
  type: MemType;
  status: Status;
  confidence: number;
  branch: string;
  agent: string;
  evidence: Evidence[];
  supersedes?: string;
  supersededBy?: string;
  walrusBlobId?: string;
  writeState: 'queued' | 'stored' | 'failed';
  expiresAt?: string;
  createdAt: string;
  events: MemoryEvent[];
  [k: string]: unknown;
}
export interface Agent {
  id: string;
  slug: string;
  name: string;
  tool: string;
  clientVersion: string | null;
  permissions: string[];
  branchScope: string | null;
  createdAt: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
  status: 'active' | 'idle' | 'revoked';
  writes7d: number;
  recalls7d: number;
  helped7d: number;
  wrong7d: number;
  tokenLastUsed: string | null;
  tokenExpiresAt?: string | null;
  tokenExpiresSoon?: boolean;
}
export interface Activity {
  id: string;
  actor_kind: string;
  actor_id: string | null;
  operation: string;
  target: Record<string, unknown> | null;
  result: string;
  latency_ms: number | null;
  request_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
  n?: string;
}
export interface Flag {
  id: string;
  memory_id: string | null;
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  state: 'open' | 'acknowledged' | 'resolved';
  detail: string;
  first_seen: string;
  last_seen: string;
}
export interface Overview {
  project: { id: string; name: string; networks: string[]; accountId: string | null };
  byTypeAndStatus: { type: MemType; status: Status; count: number }[];
  openFlags: { kind: string; severity: string; count: number }[];
  agents: {
    slug: string;
    tool: string;
    lastSeenAt: string | null;
    revoked: boolean;
    activeLast24h: boolean;
  }[];
  soonestExpiry: string | null;
  queue: Record<string, number>;
}
export interface StatusOut {
  queue: {
    queued: number;
    submitting: number;
    submitted: number;
    stored: number;
    dead: number;
    oldestPendingAgeMs: number;
  };
  relayer: { state: string; version?: string };
  gateway: { state: string; transportMix?: Record<string, number>; latencyP95?: number };
  expiry: { expiring: number; expired: number; soonest?: string };
  project: { id: string; memories: number };
}
export interface Verification {
  gateway: {
    state: string;
    consecutiveFailures: number;
    calls: number;
    errorRate: number;
    latencyP50: number;
    latencyP95: number;
    transportMix: Record<string, number>;
    creditsEstimated: number;
    configured: boolean;
  };
  credits: { used: number; budget: number } | null;
  networks: string[];
  usage: {
    byMethod: {
      method: string;
      transport: string;
      calls: number;
      avgLatencyMs: number;
      errors: number;
      credits: number;
    }[];
    hourly: { hour: string; transport: string; calls: number }[];
  };
  evidence: {
    id: string;
    memoryId: string;
    kind: string;
    ref: Evidence;
    network: string | null;
    lastVerifiedAt: string | null;
    result: string;
    nextCheckAt: string | null;
  }[];
}
export interface Storage {
  relayer: { state: string; version?: string } | null;
  queue: Record<string, number>;
  oldestPendingAgeMs: number;
  deadLetters: { id: string; memory_id: string; last_error: string | null; attempts: number }[];
  expiry: {
    memoryId: string;
    text: string;
    expiresAt: string | null;
    expired: boolean;
    renewalGeneration?: number;
    renewalPending?: boolean;
  }[];
  renewal?: { enabled: boolean };
  account: { mode: string; accountId: string | null };
  storedMemories: number;
  deletion: { tombstone: string; indexRemoval: string; permanentDeletion: string };
  [k: string]: unknown;
}
export interface Handoff {
  id: string;
  branch_slug: string;
  memory_id: string;
  agent_slug: string;
  done: string[];
  blocked: string[];
  next: string[];
  relied_on: string[];
  notes: string | null;
  created_at: string;
}
export interface Billing {
  plan: string;
  limits: Record<string, number>;
  usage: Record<string, number>;
  prices: string;
  paymentMethods: unknown[];
  invoices: unknown[];
}
export interface Branch {
  slug: string;
  protected: boolean;
  parent?: string;
  memoryCount: number;
  active: boolean;
}
export interface AlertRule {
  id: string;
  event: string;
  minSeverity?: string;
  channel?: string;
  webhookId?: string;
  quietHours?: { startHour: number; endHour: number } | null;
  grouping?: boolean;
  enabled?: boolean;
}
export interface Member {
  user_id: string;
  role: Role;
  project_scope: string[] | null;
  created_at: string;
  email?: string | null;
  display_name?: string | null;
}

/** A project's storage account. The delegate private key is never returned. */
export interface ProjectStorageView {
  mode: 'managed' | 'byo';
  relayerUrl?: string;
  network?: 'mainnet' | 'testnet';
  accountId?: string;
  delegatePublicKey?: string;
  updatedAt?: string;
  managedAllowed: boolean;
  requested?: 'byo';
  needsOwnAccount?: boolean;
  /** The deployment has no shared storage account (preview mode). */
  noSharedAccount?: boolean;
}
