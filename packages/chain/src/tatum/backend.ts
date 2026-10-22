import type {
  DatatypeInfo,
  EpochInfo,
  FunctionInfo,
  NameRecord,
  ObjectResult,
  OwnedObject,
  PackageVersion,
  SimulationResult,
  Transport,
  TxInfo,
} from '../types.js';

export type MethodName =
  | 'getTransaction'
  | 'getObject'
  | 'batchGetObjects'
  | 'listPackageVersions'
  | 'getFunction'
  | 'getDatatype'
  | 'simulate'
  | 'getEpoch'
  | 'getServiceInfo'
  | 'listOwnedObjects'
  | 'getBalance'
  | 'lookupName'
  | 'reverseLookupName';

/** One wire transport. Implementations throw ChainError; they never retry or cache. */
export interface ChainBackend {
  readonly transport: Transport;
  supports(method: MethodName): boolean;
  getTransaction(digest: string): Promise<TxInfo | null>;
  getObject(id: string, version?: string): Promise<ObjectResult>;
  batchGetObjects(ids: string[]): Promise<ObjectResult[]>;
  listPackageVersions(packageId: string): Promise<PackageVersion[] | null>;
  getFunction(packageId: string, module: string, name: string): Promise<FunctionInfo | null>;
  getDatatype(packageId: string, module: string, name: string): Promise<DatatypeInfo | null>;
  simulate(tx: { bcsBase64: string }): Promise<SimulationResult>;
  getEpoch(epoch?: string): Promise<EpochInfo>;
  getServiceInfo(): Promise<EpochInfo>;
  listOwnedObjects(owner: string, objectType?: string): Promise<OwnedObject[]>;
  getBalance(owner: string, coinType: string): Promise<{ balance: string }>;
  lookupName(name: string): Promise<NameRecord | null>;
  reverseLookupName(address: string): Promise<NameRecord | null>;
  close(): void;
}
