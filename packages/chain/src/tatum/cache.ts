export interface CachePolicy {
  /** ms; Infinity means immutable. */
  ttlMs: number;
}

export const POLICY = {
  immutable: { ttlMs: Infinity },
  current: { ttlMs: 60_000 },
  negative: { ttlMs: 5_000 },
  names: { ttlMs: 10 * 60_000 },
} as const satisfies Record<string, CachePolicy>;

interface Entry<T> {
  value: T;
  expiresAt: number;
}

/** Small LRU with per-entry TTL and an injectable clock. */
export class TtlCache {
  private readonly m = new Map<string, Entry<unknown>>();
  hits = 0;
  misses = 0;

  constructor(
    private readonly now: () => number,
    private readonly max = 5000,
  ) {}

  get<T>(key: string): T | undefined {
    const e = this.m.get(key);
    if (!e || e.expiresAt <= this.now()) {
      if (e) this.m.delete(key);
      this.misses++;
      return undefined;
    }
    this.m.delete(key);
    this.m.set(key, e); // refresh recency
    this.hits++;
    return e.value as T;
  }

  set<T>(key: string, value: T, policy: CachePolicy): void {
    this.m.set(key, { value, expiresAt: policy.ttlMs === Infinity ? Infinity : this.now() + policy.ttlMs });
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string);
  }

  invalidate(prefix: string): void {
    for (const k of [...this.m.keys()]) if (k.startsWith(prefix)) this.m.delete(k);
  }

  get size(): number {
    return this.m.size;
  }
}
