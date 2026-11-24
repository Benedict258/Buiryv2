/** Live smoke test for the Tatum gateway. Run from a machine with network access (LOCAL_CHECKS L-T2). */
import { createGatewayFromEnv } from '../packages/chain/src/index.js';
import { liveNetwork } from './lib/live-guard.js';

// Phase 12: named, consistent network settings (mainnet only with BUIRY_ALLOW_MAINNET=1) before the gateway exists.
const guard = liveNetwork(process.env);
if (!guard.ok) {
  console.error(`[chain-smoke] refused: network settings: ${guard.problems.join('; ')}`);
  process.exit(64);
}
console.log(`[chain-smoke] network ${guard.network}`);

const gw = createGatewayFromEnv(process.env, {
  sink: {
    record: (r) =>
      console.log(
        `${r.method.padEnd(20)} ${r.transport.padEnd(8)} ${String(r.latencyMs).padStart(5)}ms ${r.status.padEnd(10)} credits~${r.creditEstimate}${r.errorKind ? ` (${r.errorKind})` : ''}`,
      ),
  },
});

const KNOWN_TX = process.env.SMOKE_TX; // optional: a real digest on the configured network
const KNOWN_OBJECT =
  process.env.SMOKE_OBJECT ?? '0x0000000000000000000000000000000000000000000000000000000000000006'; // Sui clock
const KNOWN_PACKAGE =
  process.env.SMOKE_PACKAGE ?? '0x0000000000000000000000000000000000000000000000000000000000000002'; // Sui framework

console.log('service info:', JSON.stringify((await gw.getServiceInfo()).value));
console.log('object:', JSON.stringify((await gw.getObject(KNOWN_OBJECT)).value));
if (KNOWN_TX) console.log('tx:', JSON.stringify((await gw.getTransaction(KNOWN_TX)).value?.success));
console.log(
  'package versions:',
  (await gw.listPackageVersions(KNOWN_PACKAGE).catch((e) => e.message)) && 'ok',
);
console.log('status:', JSON.stringify(gw.status()));
gw.close();
