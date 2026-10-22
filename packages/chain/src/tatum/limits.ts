import { ChainError } from '../types.js';

/** Token bucket (default 3 requests/second: Tatum free plan). `acquire` waits for a token. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSec: number,
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly burst = ratePerSec,
  ) {
    this.tokens = burst;
    this.last = now();
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.ratePerSec);
    this.last = t;
  }

  async acquire(): Promise<number> {
    let waited = 0;
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return waited;
      }
      const wait = Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000);
      await this.sleep(wait);
      waited += wait;
    }
  }
}

/** Per-workspace credit budget over a fixed period so one tenant cannot drain the shared key. */
export class CreditBudget {
  private used = new Map<string, { periodStart: number; credits: number }>();

  constructor(
    private readonly limit: number,
    private readonly periodMs: number,
    private readonly now: () => number,
  ) {}

  private slot(ws: string) {
    const t = this.now();
    const s = this.used.get(ws);
    if (!s || t - s.periodStart >= this.periodMs) {
      const fresh = { periodStart: t, credits: 0 };
      this.used.set(ws, fresh);
      return fresh;
    }
    return s;
  }

  charge(ws: string, credits: number): void {
    const s = this.slot(ws);
    if (s.credits + credits > this.limit) {
      throw new ChainError(
        'budget_exceeded',
        `workspace verification credit budget exhausted (${s.credits}/${this.limit})`,
      );
    }
    s.credits += credits;
  }

  usage(ws: string): { used: number; limit: number } {
    return { used: this.slot(ws).credits, limit: this.limit };
  }
}
