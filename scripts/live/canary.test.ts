import { describe, expect, it } from 'vitest';
import { CANARY_MIN_GAP_MS, canaryAllowed } from './canary-lib.js';

// Phase 10 canary: one write on one account, a single attempt, at most one per hour. Pure part only; no network.

describe('canary pacing', () => {
  it('runs when there was no canary, refuses within the hour, and runs again after it', () => {
    const now = Date.parse('2026-11-23T12:00:00Z');
    expect(CANARY_MIN_GAP_MS).toBe(60 * 60_000);
    expect(canaryAllowed(null, now)).toEqual({ ok: true });
    expect(canaryAllowed('2026-11-23T11:30:00Z', now)).toEqual({ ok: false, waitMinutes: 30 });
    expect(canaryAllowed('2026-11-23T11:00:00Z', now)).toEqual({ ok: true });
    expect(canaryAllowed('not a time', now)).toEqual({ ok: false, waitMinutes: 60 }); // unreadable: refuse, safe side
  });
});
