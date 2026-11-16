/**
 * Measures Tatum gateway latency (read-only). Run through a profile:
 *   pnpm tsx scripts/with-env.ts testnet -- pnpm tsx scripts/tatum-latency.ts <packageId> <txDigest> [n]
 * Every call is `fresh` (no cache), paced by the gateway's own token bucket (TATUM_FREE_RPS, default 3/s).
 * Also times bare TCP and TLS connects to the gRPC host, to separate connection setup from service time.
 * Prints timings only.
 */
import { connect as tlsConnect } from 'node:tls';
import { connect as netConnect } from 'node:net';
import { createGatewayFromEnv } from '../packages/chain/src/index.js';

const [pkg, digest, nArg] = process.argv.slice(2);
if (!pkg || !digest) {
  console.error('usage: tatum-latency.ts <packageId> <txDigest> [n]');
  process.exit(64);
}
const n = Number(nArg ?? 20);
const env = process.env as Record<string, string>;
const network = `sui:${env.TATUM_NETWORK ?? 'mainnet'}`;

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};
const summary = (label: string, xs: number[]) =>
  console.log(
    `${label}: n=${xs.length} first=${xs[0]} ms; rest p50=${pct(xs.slice(1), 50)} ms p95=${pct(xs.slice(1), 95)} ms max=${Math.max(...xs.slice(1))} ms`,
  );

// Connection setup on its own: TCP connect, then a full TLS handshake, against the same host.
const hostPort = (env.TATUM_GRPC_ENDPOINT ?? '').replace(/^https?:\/\//, '').split('/')[0]!;
const [host, port] = [hostPort.split(':')[0]!, Number(hostPort.split(':')[1] ?? 443)];
const tcp: number[] = [];
const tls: number[] = [];
for (let i = 0; i < 5; i++) {
  tcp.push(
    await new Promise<number>((res, rej) => {
      const t0 = performance.now();
      const s = netConnect({ host, port }, () => {
        res(Math.round(performance.now() - t0));
        s.destroy();
      }).on('error', rej);
    }),
  );
  tls.push(
    await new Promise<number>((res, rej) => {
      const t0 = performance.now();
      const s = tlsConnect({ host, port, servername: host, ALPNProtocols: ['h2'] }, () => {
        res(Math.round(performance.now() - t0));
        s.destroy();
      }).on('error', rej);
    }),
  );
}
console.log(`network=${network} host=${host}`);
console.log(`tcp connect ms: ${tcp.join(', ')}; tls handshake (incl. tcp) ms: ${tls.join(', ')}`);

const attempts: { method: string; status: string; errorKind?: string }[] = [];
const gw = createGatewayFromEnv(env, { sink: { record: (r) => void attempts.push(r) } });
const timed = async (fn: () => Promise<unknown>) => {
  const t0 = performance.now();
  await fn();
  return Math.round(performance.now() - t0);
};
const pkgTimes: number[] = [];
const txTimes: number[] = [];
let errors = 0;
for (let i = 0; i < n; i++) {
  try {
    pkgTimes.push(await timed(() => gw.listPackageVersions(pkg, { network, fresh: true })));
  } catch {
    errors++;
  }
}
for (let i = 0; i < n; i++) {
  try {
    txTimes.push(await timed(() => gw.getTransaction(digest, { network, fresh: true })));
  } catch {
    errors++;
  }
}
summary('package version reads', pkgTimes);
summary('transaction reads', txTimes);
const st = gw.status();
console.log(
  `errors=${errors}; gateway: calls=${st.calls} transportMix=${JSON.stringify(st.transportMix)} p50=${st.latencyP50} p95=${st.latencyP95} creditsEstimated=${st.creditsEstimated}`,
);
const tally: Record<string, number> = {};
for (const a of attempts) {
  const k = `${a.method}:${a.status}${a.errorKind ? `:${a.errorKind}` : ''}`;
  tally[k] = (tally[k] ?? 0) + 1;
}
console.log(`attempts by method and status: ${JSON.stringify(tally)}`);
gw.close();
