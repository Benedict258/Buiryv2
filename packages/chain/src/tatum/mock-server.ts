/**
 * MockTatum: an in-process Sui gateway for tests and the demo. It speaks real gRPC (using the vendored
 * protos) and a small JSON-RPC subset, driven by record-shaped JSON fixtures (the response message as
 * proto-loader renders it). Nothing here claims to be a recording of the live Tatum service.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Server, ServerCredentials, status, type ServerUnaryCall, type sendUnaryData } from '@grpc/grpc-js';
import { loadSuiProtos } from './grpc.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export interface FixtureRecord {
  kind:
    | 'transaction'
    | 'object'
    | 'package_versions'
    | 'simulation'
    | 'service_info'
    | 'function'
    | 'name'
    | 'balance'
    | 'owned_objects'
    | 'epoch';
  network?: string;
  key: string;
  /** The gRPC response message body (or the entity for object/transaction). */
  response?: Json;
  /** gRPC status code to return instead of a response (5 = not found). */
  error?: { code: number; message: string };
}

export function loadFixtures(dir: string): FixtureRecord[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .flatMap((f) => {
      const parsed = JSON.parse(readFileSync(join(dir, f), 'utf8')) as FixtureRecord | FixtureRecord[];
      return Array.isArray(parsed) ? parsed : [parsed];
    });
}

export interface MockTatumOptions {
  apiKey: string;
  /** Artificial per-call delay. */
  latencyMs?: number;
}

export class MockTatum {
  readonly calls: { transport: 'grpc' | 'jsonrpc'; method: string }[] = [];
  private fixtures = new Map<string, FixtureRecord>();
  private grpc!: Server;
  private http!: HttpServer;
  grpcEndpoint = '';
  jsonrpcUrl = '';
  /** Next n calls fail with this gRPC code / HTTP status. */
  private failures: { n: number; grpcCode: number; httpStatus: number }[] = [];

  private constructor(private readonly o: MockTatumOptions) {}

  static async start(o: MockTatumOptions, fixtures: FixtureRecord[] = []): Promise<MockTatum> {
    const m = new MockTatum(o);
    for (const f of fixtures) m.add(f);
    await m.startGrpc();
    await m.startHttp();
    return m;
  }

  add(f: FixtureRecord): void {
    this.fixtures.set(`${f.kind}|${f.network ?? '*'}|${f.key}`, f);
  }

  failNext(n: number, grpcCode: number = status.UNAVAILABLE, httpStatus = 503): void {
    this.failures.push({ n, grpcCode, httpStatus });
  }
  clearFailures(): void {
    this.failures = [];
  }
  count(transport: 'grpc' | 'jsonrpc', method?: string): number {
    return this.calls.filter((c) => c.transport === transport && (!method || c.method === method)).length;
  }

  private find(kind: FixtureRecord['kind'], key: string): FixtureRecord | undefined {
    return (
      this.fixtures.get(`${kind}|*|${key}`) ??
      [...this.fixtures.values()].find((f) => f.kind === kind && f.key === key)
    );
  }

  private takeFailure(): { grpcCode: number; httpStatus: number } | null {
    const f = this.failures[0];
    if (!f) return null;
    f.n--;
    if (f.n <= 0) this.failures.shift();
    return f;
  }

  private handle(
    method: string,
    call: ServerUnaryCall<Json, Json>,
    cb: sendUnaryData<Json>,
    fn: (req: Json) => Json | { __err: { code: number; message: string } },
  ): void {
    this.calls.push({ transport: 'grpc', method });
    const finish = () => {
      if (call.metadata.get('x-api-key')[0] !== this.o.apiKey)
        return cb({ code: status.UNAUTHENTICATED, details: 'invalid api key' });
      const f = this.takeFailure();
      if (f) return cb({ code: f.grpcCode, details: 'injected failure' });
      const out = fn(call.request);
      if (out && out.__err) return cb({ code: out.__err.code, details: out.__err.message });
      cb(null, out);
    };
    if (this.o.latencyMs) setTimeout(finish, this.o.latencyMs);
    else finish();
  }

  private fromFixture(kind: FixtureRecord['kind'], key: string, wrap: (r: Json) => Json): Json {
    const f = this.find(kind, key);
    if (!f) return { __err: { code: status.NOT_FOUND, message: `${kind} ${key} not found` } };
    if (f.error) return { __err: f.error };
    return wrap(f.response);
  }

  private async startGrpc(): Promise<void> {
    const p = loadSuiProtos();
    this.grpc = new Server();
    const h = (method: string, fn: (req: Json) => Json) => ({
      [method]: (call: ServerUnaryCall<Json, Json>, cb: sendUnaryData<Json>) =>
        this.handle(method, call, cb, fn),
    });
    this.grpc.addService(p.LedgerService.service, {
      ...h('GetTransaction', (r) => this.fromFixture('transaction', r.digest, (x) => ({ transaction: x }))),
      ...h('GetObject', (r) =>
        this.fromFixture('object', r.version ? `${r.objectId}@${r.version}` : r.objectId, (x) => ({
          object: x,
        })),
      ),
      ...h('BatchGetObjects', (r) => ({
        objects: (r.requests ?? []).map((q: Json) => {
          const f = this.find('object', q.objectId);
          return f && !f.error
            ? { object: f.response }
            : { error: { code: status.NOT_FOUND, message: 'not found' } };
        }),
      })),
      ...h('GetServiceInfo', () => this.fromFixture('service_info', 'current', (x) => x)),
      ...h('GetEpoch', (r) => this.fromFixture('epoch', String(r.epoch ?? 'current'), (x) => ({ epoch: x }))),
    });
    this.grpc.addService(p.MovePackageService.service, {
      ...h('ListPackageVersions', (r) =>
        this.fromFixture('package_versions', r.packageId, (x) => ({
          versions: x.versions,
          nextPageToken: Buffer.alloc(0),
        })),
      ),
      ...h('GetFunction', (r) =>
        this.fromFixture('function', `${r.packageId}::${r.moduleName}::${r.name}`, (x) => ({ function: x })),
      ),
      ...h('GetDatatype', () => ({ __err: { code: status.NOT_FOUND, message: 'no datatype fixture' } })),
    });
    this.grpc.addService(p.StateService.service, {
      ...h('ListOwnedObjects', (r) =>
        this.fromFixture('owned_objects', r.owner, (x) => ({
          objects: x.objects,
          nextPageToken: Buffer.alloc(0),
        })),
      ),
      ...h('GetBalance', (r) =>
        this.fromFixture('balance', `${r.owner}::${r.coinType}`, (x) => ({ balance: x })),
      ),
    });
    this.grpc.addService(p.TransactionExecutionService.service, {
      ...h('SimulateTransaction', () => this.fromFixture('simulation', 'default', (x) => x)),
    });
    this.grpc.addService(p.NameService.service, {
      ...h('LookupName', (r) => this.fromFixture('name', r.name, (x) => ({ record: x }))),
      ...h('ReverseLookupName', (r) => this.fromFixture('name', r.address, (x) => ({ record: x }))),
    });
    const port = await new Promise<number>((resolve, reject) =>
      this.grpc.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (e, pt) =>
        e ? reject(e) : resolve(pt),
      ),
    );
    this.grpcEndpoint = `127.0.0.1:${port}`;
  }

  private async startHttp(): Promise<void> {
    this.http = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (req.headers['x-api-key'] !== this.o.apiKey) return send(401, { error: 'invalid api key' });
        const f = this.takeFailure();
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Json;
        this.calls.push({ transport: 'jsonrpc', method: String(body.method) });
        if (f) return send(f.httpStatus, { error: 'injected failure' });
        const ok = (result: unknown) => send(200, { jsonrpc: '2.0', id: body.id, result });
        const objectJson = (o: Json) => ({
          data: {
            objectId: o.objectId,
            version: String(o.version),
            digest: o.digest,
            type: o.objectType,
            owner:
              o.owner?.kind === 'IMMUTABLE'
                ? 'Immutable'
                : o.owner?.address
                  ? { AddressOwner: o.owner.address }
                  : undefined,
          },
        });
        switch (body.method) {
          case 'sui_getObject': {
            const fx = this.find('object', body.params[0]);
            return ok(
              fx && !fx.error
                ? objectJson(fx.response)
                : { error: { code: 'notExists', object_id: body.params[0] } },
            );
          }
          case 'sui_multiGetObjects':
            return ok(
              body.params[0].map((id: string) => {
                const fx = this.find('object', id);
                return fx && !fx.error
                  ? objectJson(fx.response)
                  : { error: { code: 'notExists', object_id: id } };
              }),
            );
          case 'sui_getTransactionBlock': {
            const fx = this.find('transaction', body.params[0]);
            if (!fx || fx.error)
              return send(200, {
                jsonrpc: '2.0',
                id: body.id,
                error: {
                  code: -32602,
                  message: `Could not find the referenced transaction [TransactionDigest(${body.params[0]})].`,
                },
              });
            const t = fx.response;
            return ok({
              digest: t.digest,
              checkpoint: t.checkpoint,
              timestampMs: t.timestamp ? String(Number(t.timestamp.seconds) * 1000) : undefined,
              effects: {
                status: t.effects.status.success
                  ? { status: 'success' }
                  : { status: 'failure', error: t.effects.status.error?.description },
                executedEpoch: t.effects.epoch,
              },
              objectChanges: (t.effects.changedObjects ?? []).map((c: Json) =>
                c.outputState === 'OUTPUT_OBJECT_STATE_PACKAGE_WRITE'
                  ? { type: 'published', packageId: c.objectId, version: c.outputVersion }
                  : {
                      type: c.idOperation === 'CREATED' ? 'created' : 'mutated',
                      objectId: c.objectId,
                      version: c.outputVersion,
                      digest: c.outputDigest,
                      objectType: c.objectType,
                    },
              ),
            });
          }
          case 'suix_getLatestSuiSystemState':
            return ok({ epoch: this.find('service_info', 'current')?.response?.epoch ?? '0' });
          case 'sui_getChainIdentifier':
            return ok(this.find('service_info', 'current')?.response?.chainId ?? 'mock');
          default:
            return send(200, {
              jsonrpc: '2.0',
              id: body.id,
              error: { code: -32601, message: 'Method not found' },
            });
        }
      });
    });
    await new Promise<void>((r) => this.http.listen(0, '127.0.0.1', r));
    this.jsonrpcUrl = `http://127.0.0.1:${(this.http.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    this.grpc.forceShutdown();
    await new Promise<void>((r) => this.http.close(() => r()));
  }
}
