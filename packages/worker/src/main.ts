import {
  buildRuntime,
  createAccountDrains,
  createDrain,
  deliverDue,
  rewriteRenewer,
  startHttp,
} from '@buiry/api';
import {
  driftScan,
  expiryScan,
  isolationCanary,
  ownRelayerProbe,
  relayerProbe,
  snapshotRegen,
} from './index.js';
import { Scheduler, jobFailureLine, jobRunLine, type ScheduledJob } from './scheduler.js';

/**
 * Runs the API and MCP endpoint, the background jobs, or both (BUIRY_ROLE = api | worker | all, default all). On
 * AWS the API and the worker run as separate services; job leases make several workers safe.
 */
export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const role = env.BUIRY_ROLE ?? 'all';
  const rt = await buildRuntime(env);
  const http = role === 'worker' ? undefined : await startHttp(rt);
  if (http) console.log(`[buiry] listening on ${http.url} (REST /v1, MCP /mcp)`);
  if (role === 'api') {
    const stopApi = async () => {
      await http!.close();
      await rt.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void stopApi());
    process.on('SIGTERM', () => void stopApi());
    return;
  }
  console.log(`[buiry] background jobs running (role ${role})`);
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
  // Each project's own relayer (preview has no shared account): a notice in Alerts and briefings while degraded (F3).
  if (rt.deps.storage) {
    const storage = rt.deps.storage;
    jobs.push({ name: 'own-relayer-probe', intervalMs: min, run: () => ownRelayerProbe(rt.deps, storage) });
  }
  jobs.push({ name: 'webhooks', intervalMs: 5_000, run: () => deliverDue(rt.deps) });
  jobs.push({ name: 'drift-scan', intervalMs: 6 * 60 * min, run: () => driftScan(rt.deps) });
  jobs.push({ name: 'snapshot', intervalMs: 5 * min, run: () => snapshotRegen(rt.deps) });
  jobs.push({ name: 'isolation-canary', intervalMs: 60 * min, run: () => isolationCanary(rt.deps) });
  const scheduler = new Scheduler(rt.deps, `proc-${process.pid}`, jobs);
  const timer = setInterval(
    () =>
      void scheduler.tick().then((r) => {
        for (const x of r.ran) {
          // The failure line stays as it is: the job-failures alarm matches it.
          if (!x.ok) console.error(jobFailureLine(x.name, x.error));
          if (env.BUIRY_REQUEST_LOG !== 'off') console.log(jobRunLine(x));
        }
      }),
    1_000,
  );
  const stop = async () => {
    clearInterval(timer);
    await http?.close();
    await rt.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}
