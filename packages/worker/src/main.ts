import {
  buildRuntime,
  createAccountDrains,
  createDrain,
  deliverDue,
  rewriteRenewer,
  startHttp,
} from '@buiry/api';
import { driftScan, expiryScan, isolationCanary, relayerProbe, snapshotRegen } from './index.js';
import { Scheduler, type ScheduledJob } from './scheduler.js';

/** Runs the API, the MCP endpoint and the background jobs in one process. */
export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const rt = await buildRuntime(env);
  const http = await startHttp(rt);
  console.log(`[buiry] listening on ${http.url} (REST /v1, MCP /mcp)`);
  const min = 60_000;
  const jobs: ScheduledJob[] = [];
  const workerId = `worker-${process.pid}`;
  // Renewal by rewrite, behind BUIRY_RENEWAL=on (off by default).
  const renewal = rt.deps.renewalEnabled ? { renewalEnabled: true, renewer: rewriteRenewer(rt.deps) } : {};
  // One drain per storage account: the managed one and each project's own (bring your own).
  if (rt.deps.storage) {
    const drains = createAccountDrains(rt.deps, rt.deps.storage, { workerId });
    jobs.push({ name: 'write-drain', intervalMs: 2_000, run: () => drains.tick() });
    jobs.push({
      name: 'expiry-scan',
      intervalMs: 6 * 60 * min,
      run: () =>
        expiryScan(rt.deps, {
          ...(rt.adapter ? { adapter: rt.adapter } : {}),
          checkIntervalMs: 6 * 60 * min,
          ...renewal,
        }),
    });
  } else if (rt.adapter) {
    const drain = createDrain(rt.deps, rt.adapter, { workerId });
    jobs.push({ name: 'write-drain', intervalMs: 2_000, run: () => drain.tick() });
    jobs.push({
      name: 'expiry-scan',
      intervalMs: 6 * 60 * min,
      run: () => expiryScan(rt.deps, { adapter: rt.adapter!, checkIntervalMs: 6 * 60 * min, ...renewal }),
    });
  }
  if (rt.adapter) {
    jobs.push({
      name: 'relayer-probe',
      intervalMs: min,
      run: () => relayerProbe(rt.deps, rt.adapter!, env.WALRUS_RELAYER_URL ?? ''),
    });
  }
  jobs.push({ name: 'webhooks', intervalMs: 5_000, run: () => deliverDue(rt.deps) });
  jobs.push({ name: 'drift-scan', intervalMs: 6 * 60 * min, run: () => driftScan(rt.deps) });
  jobs.push({ name: 'snapshot', intervalMs: 5 * min, run: () => snapshotRegen(rt.deps) });
  jobs.push({ name: 'isolation-canary', intervalMs: 60 * min, run: () => isolationCanary(rt.deps) });
  const scheduler = new Scheduler(rt.deps, `proc-${process.pid}`, jobs);
  const timer = setInterval(
    () =>
      void scheduler
        .tick()
        .then((r) =>
          r.ran
            .filter((x) => !x.ok)
            .forEach((x) => console.error(`[buiry] job ${x.name} failed: ${x.error}`)),
        ),
    1_000,
  );
  const stop = async () => {
    clearInterval(timer);
    await http.close();
    await rt.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}
