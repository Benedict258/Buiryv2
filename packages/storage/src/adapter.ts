// Walrus Memory access is confined to this package (architecture principle 4).
// Endpoint paths and JSON shapes are ASSUMED (docs/ASSUMPTIONS.md A13-A15).

export type WriteState = 'ok' | 'degraded' | 'paused';

export type RelayerErrorKind =
  'rate_limited' | 'unavailable' | 'timeout' | 'paused' | 'auth' | 'client' | 'not_found' | 'unknown';

export class RelayerError extends Error {
  constructor(
    public readonly kind: RelayerErrorKind,
    message: string,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RelayerError';
  }

  /** Authentication and client errors are never retried. */
  get retryable(): boolean {
    return (
      this.kind === 'rate_limited' ||
      this.kind === 'unavailable' ||
      this.kind === 'timeout' ||
      this.kind === 'paused' ||
      this.kind === 'unknown'
    );
  }
}

export interface RelayerHealth {
  reachable: boolean;
  writeState: WriteState;
  version?: string;
}

export interface RelayerVersion {
  version: string;
  packageId?: string;
}

export type JobStatus =
  | { state: 'pending' | 'running' }
  | { state: 'done'; blobId: string }
  | { state: 'failed'; error: string; retryable: boolean };

export interface RecallRequest {
  namespace: string;
  query: string;
  /** Relayer caps at 100. */
  limit?: number;
  sort?: 'relevance' | 'recent';
  weights?: { semantic?: number; recency?: number };
  deadlineMs?: number;
}

export interface RecalledMemory {
  blobId: string;
  text: string;
  score?: number;
  createdAt?: number;
  agentId?: string;
}

export interface MemoryListItem {
  blobId: string;
  namespace: string;
  sizeBytes: number;
  agentId?: string;
  status: string;
  endEpoch?: number;
  expiresAt?: number;
}

export interface MemoryListPage {
  items: MemoryListItem[];
  nextCursor?: string;
  hardDeleted: string[];
}

export interface WalrusMemoryAdapter {
  /** Throws RelayerError('client') when the relayer version is unsupported. */
  checkCompatibility(): Promise<RelayerVersion>;
  health(): Promise<RelayerHealth>;
  remember(namespace: string, text: string): Promise<{ jobId: string }>;
  /** Up to 20 items; returns one job id per item, in order. */
  rememberBulk(namespace: string, texts: string[]): Promise<{ jobIds: string[] }>;
  getJob(jobId: string): Promise<JobStatus>;
  recall(req: RecallRequest): Promise<{ results: RecalledMemory[] }>;
  /** Memories never recalled (candidates for cleanup). ASSUMED endpoint. */
  analyzeUnused(namespace: string): Promise<{ results: RecalledMemory[] }>;
  /** Newest first, no cursor, not proof of completeness. */
  restore(namespace: string, limit?: number): Promise<{ results: RecalledMemory[] }>;
  /** Memory read API listing (A3 ASSUMED to accept the delegate key). */
  list(opts: { namespace?: string; cursor?: string; limit?: number }): Promise<MemoryListPage>;
  /** Index removal only: blobs remain on Walrus. */
  forget(namespace: string): Promise<void>;
}

export const MAX_BULK = 20;

/** Walrus epoch length on Mainnet (about two weeks, per the supplied docs; see ASSUMPTIONS). */
export const EPOCH_MS = 14 * 86_400_000;
