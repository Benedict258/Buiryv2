import { walrusEpochMs } from '@buiry/core';
import type { WalrusMemoryAdapter } from './adapter.js';

export interface StoredRef {
  memoryId: string;
  blobId: string;
  namespace: string;
}

export interface ExpiryStore {
  listStoredMemories(): Promise<StoredRef[]>;
  setExpiry(memoryId: string, e: { endEpoch?: number; expiresAt?: number }): Promise<void>;
  markExpired(memoryId: string): Promise<void>;
}

/** Renewal is ASSUMED possible only if the operator owns the blobs (A1). Not implemented against a real service. */
export interface Renewer {
  renew(blobIds: string[]): Promise<{ renewed: string[]; failed: string[] }>;
}

export interface ExpiryReport {
  expiring: { memoryId: string; blobId: string; expiresAt: number }[];
  expired: string[];
  /** In the index but absent from the relayer listing (could not be verified). */
  missing: string[];
  deleted: string[];
  renewed: string[];
  scanned: number;
}

export interface ExpiryOptions {
  adapter: WalrusMemoryAdapter;
  store: ExpiryStore;
  now: number;
  checkIntervalMs: number;
  /** Sui network of the deployment; sets the epoch length (Mainnet when unknown). */
  network?: string;
  /** Feature flag; default off. */
  renewalEnabled?: boolean;
  renewer?: Renewer;
}

/** Margin: more than two check intervals and at least two epochs. */
export function expiryMargin(checkIntervalMs: number, network?: string): number {
  return Math.max(2 * walrusEpochMs(network), 2 * checkIntervalMs + 1);
}

export async function reconcileExpiry(o: ExpiryOptions): Promise<ExpiryReport> {
  const refs = await o.store.listStoredMemories();
  const byBlob = new Map<string, { expiresAt?: number; endEpoch?: number; status: string }>();
  const deleted = new Set<string>();
  const namespaces = [...new Set(refs.map((r) => r.namespace))];
  for (const namespace of namespaces) {
    let cursor: string | undefined;
    do {
      const page = await o.adapter.list({ namespace, ...(cursor ? { cursor } : {}), limit: 100 });
      for (const it of page.items) {
        byBlob.set(it.blobId, {
          status: it.status,
          ...(it.expiresAt !== undefined ? { expiresAt: it.expiresAt } : {}),
          ...(it.endEpoch !== undefined ? { endEpoch: it.endEpoch } : {}),
        });
      }
      for (const d of page.hardDeleted) deleted.add(d);
      cursor = page.nextCursor;
    } while (cursor);
  }

  const report: ExpiryReport = {
    expiring: [],
    expired: [],
    missing: [],
    deleted: [],
    renewed: [],
    scanned: refs.length,
  };
  const margin = expiryMargin(o.checkIntervalMs, o.network);
  for (const r of refs) {
    if (deleted.has(r.blobId)) {
      report.deleted.push(r.memoryId);
      await o.store.markExpired(r.memoryId);
      continue;
    }
    const it = byBlob.get(r.blobId);
    if (!it) {
      report.missing.push(r.memoryId);
      continue;
    }
    await o.store.setExpiry(r.memoryId, {
      ...(it.endEpoch !== undefined ? { endEpoch: it.endEpoch } : {}),
      ...(it.expiresAt !== undefined ? { expiresAt: it.expiresAt } : {}),
    });
    if (it.status === 'expired' || (it.expiresAt !== undefined && it.expiresAt <= o.now)) {
      report.expired.push(r.memoryId);
      await o.store.markExpired(r.memoryId);
    } else if (it.expiresAt !== undefined && it.expiresAt - o.now <= margin) {
      report.expiring.push({ memoryId: r.memoryId, blobId: r.blobId, expiresAt: it.expiresAt });
    }
  }

  if (o.renewalEnabled && o.renewer && report.expiring.length > 0) {
    const res = await o.renewer.renew(report.expiring.map((e) => e.blobId));
    report.renewed = report.expiring.filter((e) => res.renewed.includes(e.blobId)).map((e) => e.memoryId);
    report.expiring = report.expiring.filter((e) => !res.renewed.includes(e.blobId));
  }
  return report;
}
