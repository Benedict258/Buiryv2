// Walrus Memory access is confined to this package (architecture principle 4).
// Endpoint paths, headers and JSON shapes follow the relayer docs read 2026-10-28 (docs/ASSUMPTIONS.md A13-A15);
// fields the docs leave unspecified are called out where they are parsed and are settled by LOCAL_CHECKS L-W1/L-W2.

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
  /** An explicit sort makes the relayer ignore `weights`. */
  sort?: 'relevance' | 'recent';
  weights?: { semantic?: number; recency?: number };
  deadlineMs?: number;
}

export interface RecalledMemory {
  blobId: string;
  text: string;
  /** Present only when the relayer computed a combined score (recency or importance weights). */
  score?: number;
  /** Cosine distance from the relayer; lower is closer. */
  distance?: number;
  createdAt?: number;
  agentId?: string;
}

/**
 * Recall response. The live relayer can answer HTTP 200 with `degraded: true` and a `dropped_count`: it found
 * candidates but could not return them (seen live right after writes). That is not "no match".
 */
export interface RecallResponse {
  results: RecalledMemory[];
  /** The relayer reported a degraded recall; results may be incomplete. */
  degraded?: boolean;
  /** Candidates the relayer found but dropped. */
  dropped?: number;
}

/** `/api/restore` rebuilds the relayer's index server-side and returns counts only, never memory text. */
export interface RestoreResult {
  restored: number;
  skipped: number;
  failed: number;
  total: number;
  /** True means the call was incomplete and is worth retrying. */
  truncated: boolean;
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
  /** A repeated idempotency key collapses onto the existing relayer job. */
  remember(namespace: string, text: string, opts?: WriteOptions): Promise<{ jobId: string }>;
  /** Up to 20 items; returns one job id per item, in order. */
  rememberBulk(namespace: string, texts: string[], opts?: WriteOptions): Promise<{ jobIds: string[] }>;
  getJob(jobId: string): Promise<JobStatus>;
  recall(req: RecallRequest): Promise<RecallResponse>;
  /** Re-indexes owned blobs the relayer lacks. Newest first, limit 1..100, no cursor; counts only. */
  restore(namespace: string, limit?: number): Promise<RestoreResult>;
  /** Memory Read API listing: a signed GET with the delegate key (A3). */
  list(opts: { namespace?: string; cursor?: string; limit?: number }): Promise<MemoryListPage>;
  /** Index removal only: blobs remain on Walrus. */
  forget(namespace: string): Promise<void>;
}

export interface WriteOptions {
  /** At most 255 UTF-8 bytes. Reusing a key with different text is a conflict (409). */
  idempotencyKey?: string;
}

export const MAX_BULK = 20;

/** Walrus epoch length on Mainnet (about two weeks, per the supplied docs; see ASSUMPTIONS). */
export const EPOCH_MS = 14 * 86_400_000;
