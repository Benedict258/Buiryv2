export type Network = string; // e.g. "sui:mainnet", "sui:testnet", "evm:ethereum-mainnet"

export type ChainErrorKind =
  | 'config' // gRPC 16 / HTTP 401/403: bad or missing key; never retried
  | 'not_found' // gRPC 5: absent or pruned
  | 'unavailable' // gRPC 14, timeouts, network: retried, marks degraded
  | 'rate_limited'
  | 'budget_exceeded' // per-workspace credit budget
  | 'invalid'
  | 'unsupported' // transport cannot serve the method
  | 'unknown';

export class ChainError extends Error {
  constructor(
    public readonly kind: ChainErrorKind,
    message: string,
    public readonly code?: number,
  ) {
    super(message);
    this.name = 'ChainError';
  }
  get retryable(): boolean {
    return this.kind === 'unavailable' || this.kind === 'rate_limited';
  }
}

export type Transport = 'grpc' | 'jsonrpc';

export interface ChangedObject {
  objectId: string;
  idOperation: 'created' | 'deleted' | 'none';
  outputKind: 'object' | 'package' | 'deleted' | 'other';
  inputVersion?: string;
  outputVersion?: string;
  outputDigest?: string;
  objectType?: string;
}

export interface TxInfo {
  digest: string;
  success: boolean;
  error?: string;
  epoch?: string;
  checkpoint?: string;
  timestampMs?: number;
  changed: ChangedObject[];
}

export interface ObjectInfo {
  id: string;
  version: string;
  digest: string;
  type?: string;
  owner?: { kind: string; address?: string };
}

/** Object lookup outcome: absence is data, not an exception. */
export type ObjectResult = { found: true; object: ObjectInfo } | { found: false; id: string; reason: string };

export interface PackageVersion {
  packageId: string;
  version: string;
}

export interface FunctionInfo {
  name: string;
  visibility?: string;
  isEntry?: boolean;
  parameterCount: number;
  returnCount: number;
}

export interface DatatypeInfo {
  typeName: string;
  kind?: string;
  fieldCount: number;
}

export interface SimulationResult {
  success: boolean;
  error?: { description: string; kind?: string; command?: string };
  gasUsed?: string;
}

export interface EpochInfo {
  epoch: string;
  chainId?: string;
  checkpointHeight?: string;
  lowestAvailableCheckpoint?: string;
  startMs?: number;
  endMs?: number;
}

export interface OwnedObject {
  id: string;
  version: string;
  type: string;
}

export interface NameRecord {
  name: string;
  targetAddress?: string;
}

/** Gateway-level result wrapper carrying provenance. */
export interface Provenance {
  transport: Transport | 'cache';
  network: Network;
  latencyMs: number;
  cached: boolean;
}

export type Verdict = 'pass' | 'fail' | 'unknown';
