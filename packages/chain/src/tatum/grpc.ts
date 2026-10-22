import { fileURLToPath } from 'node:url';
import {
  credentials,
  Metadata,
  status as Status,
  type ServiceError,
  loadPackageDefinition,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { ChainError, type ChangedObject, type EpochInfo, type ObjectResult, type TxInfo } from '../types.js';
import type { ChainBackend, MethodName } from './backend.js';

export const PROTO_ROOT = fileURLToPath(new URL('../../proto', import.meta.url));
const FILES = [
  'sui/rpc/v2/ledger_service.proto',
  'sui/rpc/v2/state_service.proto',
  'sui/rpc/v2/move_package_service.proto',
  'sui/rpc/v2/transaction_execution_service.proto',
  'sui/rpc/v2/name_service.proto',
];

/** u64 values are decoded as strings (longs: String) and compared as BigInt by callers. */
export const LOADER_OPTIONS = {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: false,
  oneofs: true,
  includeDirs: [PROTO_ROOT],
} as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Anything = any;

let cached: Anything;
export function loadSuiProtos(): Anything {
  if (!cached)
    cached = loadPackageDefinition(loadSync(FILES, { ...LOADER_OPTIONS, includeDirs: [PROTO_ROOT] }));
  return (cached as Anything).sui.rpc.v2;
}

export function mapGrpcError(e: unknown): ChainError {
  const err = e as Partial<ServiceError>;
  const code = typeof err.code === 'number' ? err.code : undefined;
  const msg = err.details || err.message || 'grpc error';
  switch (code) {
    case Status.UNAUTHENTICATED:
    case Status.PERMISSION_DENIED:
      return new ChainError('config', `gateway rejected the API key: ${msg}`, code);
    case Status.NOT_FOUND:
      return new ChainError('not_found', msg, code);
    case Status.UNAVAILABLE:
    case Status.DEADLINE_EXCEEDED:
    case Status.ABORTED:
    case Status.INTERNAL:
      return new ChainError('unavailable', msg, code);
    case Status.RESOURCE_EXHAUSTED:
      return new ChainError('rate_limited', msg, code);
    case Status.INVALID_ARGUMENT:
    case Status.OUT_OF_RANGE:
      return new ChainError('invalid', msg, code);
    case Status.UNIMPLEMENTED:
      return new ChainError('unsupported', msg, code);
    case undefined:
      return new ChainError('unavailable', msg);
    default:
      return new ChainError('unknown', msg, code);
  }
}

export interface GrpcOptions {
  /** host:port, TLS on 443 unless `insecure`. */
  endpoint: string;
  apiKey: string;
  insecure?: boolean;
  deadlineMs?: number;
}

const OBJECT_MASK = ['object_id', 'version', 'digest', 'owner', 'object_type'];
const TX_MASK = [
  'digest',
  'checkpoint',
  'timestamp',
  'effects.status',
  'effects.epoch',
  'effects.changed_objects',
];

const OWNER_KIND: Record<string, string> = {
  ADDRESS: 'address',
  OBJECT: 'object',
  SHARED: 'shared',
  IMMUTABLE: 'immutable',
  CONSENSUS_ADDRESS: 'consensus_address',
};

function timestampMs(t?: { seconds?: string; nanos?: number }): number | undefined {
  return t?.seconds === undefined ? undefined : Number(t.seconds) * 1000 + Math.floor((t.nanos ?? 0) / 1e6);
}

function toObject(o: Anything): ObjectResult {
  return {
    found: true,
    object: {
      id: o.objectId,
      version: String(o.version ?? ''),
      digest: o.digest ?? '',
      ...(o.objectType ? { type: o.objectType } : {}),
      ...(o.owner
        ? {
            owner: {
              kind: OWNER_KIND[o.owner.kind] ?? 'unknown',
              ...(o.owner.address ? { address: o.owner.address } : {}),
            },
          }
        : {}),
    },
  };
}

function toTx(t: Anything): TxInfo {
  const st = t.effects?.status;
  const changed: ChangedObject[] = (t.effects?.changedObjects ?? []).map((c: Anything) => ({
    objectId: c.objectId,
    idOperation: c.idOperation === 'CREATED' ? 'created' : c.idOperation === 'DELETED' ? 'deleted' : 'none',
    outputKind:
      c.outputState === 'OUTPUT_OBJECT_STATE_PACKAGE_WRITE'
        ? 'package'
        : c.outputState === 'OUTPUT_OBJECT_STATE_OBJECT_WRITE'
          ? 'object'
          : c.outputState === 'OUTPUT_OBJECT_STATE_DOES_NOT_EXIST'
            ? 'deleted'
            : 'other',
    ...(c.inputVersion !== undefined ? { inputVersion: String(c.inputVersion) } : {}),
    ...(c.outputVersion !== undefined ? { outputVersion: String(c.outputVersion) } : {}),
    ...(c.outputDigest ? { outputDigest: c.outputDigest } : {}),
    ...(c.objectType ? { objectType: c.objectType } : {}),
  }));
  const ms = timestampMs(t.timestamp);
  return {
    digest: t.digest,
    success: st?.success === true,
    ...(st?.success === false ? { error: st.error?.description ?? 'execution failed' } : {}),
    ...(t.effects?.epoch !== undefined ? { epoch: String(t.effects.epoch) } : {}),
    ...(t.checkpoint !== undefined ? { checkpoint: String(t.checkpoint) } : {}),
    ...(ms !== undefined ? { timestampMs: ms } : {}),
    changed,
  };
}

export class GrpcBackend implements ChainBackend {
  readonly transport = 'grpc' as const;
  private readonly clients: Record<'ledger' | 'state' | 'pkg' | 'exec' | 'name', Anything>;

  constructor(private readonly o: GrpcOptions) {
    const proto = loadSuiProtos();
    const creds = o.insecure ? credentials.createInsecure() : credentials.createSsl();
    this.clients = {
      ledger: new proto.LedgerService(o.endpoint, creds),
      state: new proto.StateService(o.endpoint, creds),
      pkg: new proto.MovePackageService(o.endpoint, creds),
      exec: new proto.TransactionExecutionService(o.endpoint, creds),
      name: new proto.NameService(o.endpoint, creds),
    };
  }

  supports(_m: MethodName): boolean {
    return true;
  }

  private call<T = Anything>(svc: keyof GrpcBackend['clients'], method: string, req: Anything): Promise<T> {
    const md = new Metadata();
    md.set('x-api-key', this.o.apiKey);
    return new Promise((resolve, reject) => {
      this.clients[svc][method](
        req,
        md,
        { deadline: Date.now() + (this.o.deadlineMs ?? 10_000) },
        (err: ServiceError | null, res: T) => (err ? reject(mapGrpcError(err)) : resolve(res)),
      );
    });
  }

  async getTransaction(digest: string): Promise<TxInfo | null> {
    try {
      const r = await this.call('ledger', 'GetTransaction', { digest, readMask: { paths: TX_MASK } });
      return r.transaction ? toTx(r.transaction) : null;
    } catch (e) {
      if (e instanceof ChainError && e.kind === 'not_found') return null;
      throw e;
    }
  }

  async getObject(id: string, version?: string): Promise<ObjectResult> {
    try {
      const r = await this.call('ledger', 'GetObject', {
        objectId: id,
        ...(version !== undefined ? { version } : {}),
        readMask: { paths: OBJECT_MASK },
      });
      return r.object ? toObject(r.object) : { found: false, id, reason: 'empty response' };
    } catch (e) {
      if (e instanceof ChainError && e.kind === 'not_found') return { found: false, id, reason: e.message };
      throw e;
    }
  }

  async batchGetObjects(ids: string[]): Promise<ObjectResult[]> {
    const r = await this.call('ledger', 'BatchGetObjects', {
      requests: ids.map((objectId) => ({ objectId })),
      readMask: { paths: OBJECT_MASK },
    });
    return ids.map((id, i) => {
      const item = r.objects?.[i];
      if (item?.object) return toObject(item.object);
      return { found: false as const, id, reason: item?.error?.message ?? 'not found' };
    });
  }

  async listPackageVersions(packageId: string) {
    const out: { packageId: string; version: string }[] = [];
    let token: Buffer | undefined;
    try {
      do {
        const r = await this.call('pkg', 'ListPackageVersions', {
          packageId,
          pageSize: 100,
          ...(token ? { pageToken: token } : {}),
        });
        for (const v of r.versions ?? []) out.push({ packageId: v.packageId, version: String(v.version) });
        token = r.nextPageToken && r.nextPageToken.length ? r.nextPageToken : undefined;
      } while (token);
    } catch (e) {
      if (e instanceof ChainError && e.kind === 'not_found') return null;
      throw e;
    }
    return out;
  }

  async getFunction(packageId: string, module: string, name: string) {
    try {
      const r = await this.call('pkg', 'GetFunction', { packageId, moduleName: module, name });
      const f = r.function;
      if (!f) return null;
      return {
        name: f.name,
        ...(f.visibility ? { visibility: String(f.visibility) } : {}),
        ...(f.isEntry !== undefined ? { isEntry: Boolean(f.isEntry) } : {}),
        parameterCount: (f.parameters ?? []).length,
        returnCount: (f.returns ?? []).length,
      };
    } catch (e) {
      if (e instanceof ChainError && e.kind === 'not_found') return null;
      throw e;
    }
  }

  async getDatatype(packageId: string, module: string, name: string) {
    try {
      const r = await this.call('pkg', 'GetDatatype', { packageId, moduleName: module, name });
      const d = r.datatype;
      if (!d) return null;
      return {
        typeName: d.typeName ?? name,
        ...(d.kind ? { kind: String(d.kind) } : {}),
        fieldCount: (d.fields ?? []).length,
      };
    } catch (e) {
      if (e instanceof ChainError && e.kind === 'not_found') return null;
      throw e;
    }
  }

  async simulate(tx: { bcsBase64: string }) {
    const r = await this.call('exec', 'SimulateTransaction', {
      transaction: { bcs: { name: 'TransactionData', value: Buffer.from(tx.bcsBase64, 'base64') } },
      readMask: { paths: ['transaction.effects.status', 'transaction.effects.gas_used'] },
      checks: 'ENABLED',
      doGasSelection: true,
    });
    const st = r.transaction?.effects?.status;
    if (st?.success === false) {
      return {
        success: false,
        error: {
          description: st.error?.description ?? 'simulation failed',
          ...(st.error?.kind ? { kind: String(st.error.kind) } : {}),
          ...(st.error?.command !== undefined ? { command: String(st.error.command) } : {}),
        },
      };
    }
    return {
      success: true,
      ...(r.transaction?.effects?.gasUsed?.computationCost
        ? { gasUsed: String(r.transaction.effects.gasUsed.computationCost) }
        : {}),
    };
  }

  private toEpoch(r: Anything): EpochInfo {
    return {
      epoch: String(r.epoch ?? ''),
      ...(r.chainId ? { chainId: r.chainId } : {}),
      ...(r.checkpointHeight !== undefined ? { checkpointHeight: String(r.checkpointHeight) } : {}),
      ...(r.lowestAvailableCheckpoint !== undefined
        ? { lowestAvailableCheckpoint: String(r.lowestAvailableCheckpoint) }
        : {}),
    };
  }

  async getServiceInfo(): Promise<EpochInfo> {
    return this.toEpoch(await this.call('ledger', 'GetServiceInfo', {}));
  }

  async getEpoch(epoch?: string): Promise<EpochInfo> {
    if (epoch === undefined) return this.getServiceInfo();
    const r = await this.call('ledger', 'GetEpoch', {
      epoch,
      readMask: { paths: ['epoch', 'start', 'end'] },
    });
    const e = r.epoch ?? {};
    const startMs = timestampMs(e.start);
    const endMs = timestampMs(e.end);
    return {
      epoch: String(e.epoch ?? epoch),
      ...(startMs !== undefined ? { startMs } : {}),
      ...(endMs !== undefined ? { endMs } : {}),
    };
  }

  async listOwnedObjects(owner: string, objectType?: string) {
    const out: { id: string; version: string; type: string }[] = [];
    let token: Buffer | undefined;
    do {
      const r = await this.call('state', 'ListOwnedObjects', {
        owner,
        pageSize: 100,
        ...(objectType ? { objectType } : {}),
        ...(token ? { pageToken: token } : {}),
        readMask: { paths: ['object_id', 'version', 'object_type'] },
      });
      for (const o of r.objects ?? [])
        out.push({ id: o.objectId, version: String(o.version), type: o.objectType ?? '' });
      token = r.nextPageToken && r.nextPageToken.length ? r.nextPageToken : undefined;
    } while (token);
    return out;
  }

  async getBalance(owner: string, coinType: string) {
    const r = await this.call('state', 'GetBalance', { owner, coinType });
    return { balance: String(r.balance?.balance ?? '0') };
  }

  async lookupName(name: string) {
    try {
      const r = await this.call('name', 'LookupName', { name });
      return r.record
        ? {
            name: r.record.name ?? name,
            ...(r.record.targetAddress ? { targetAddress: r.record.targetAddress } : {}),
          }
        : null;
    } catch (e) {
      if (e instanceof ChainError && e.kind === 'not_found') return null;
      throw e;
    }
  }

  async reverseLookupName(address: string) {
    try {
      const r = await this.call('name', 'ReverseLookupName', { address });
      return r.record ? { name: r.record.name, targetAddress: address } : null;
    } catch (e) {
      if (e instanceof ChainError && e.kind === 'not_found') return null;
      throw e;
    }
  }

  close(): void {
    for (const c of Object.values(this.clients)) (c as Anything).close?.();
  }
}
