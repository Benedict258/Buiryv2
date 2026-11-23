/** Canary pacing (Phase 10): at most one canary write per hour. Pure. */
export const CANARY_MIN_GAP_MS = 60 * 60_000;

/** Whether a canary may run now, given when the last one started (ISO time) or null if none ever ran. */
export function canaryAllowed(
  lastAt: string | null,
  now: number,
): { ok: true } | { ok: false; waitMinutes: number } {
  if (lastAt === null) return { ok: true };
  const t = Date.parse(lastAt);
  if (Number.isNaN(t)) return { ok: false, waitMinutes: 60 }; // unreadable record: refuse on the safe side
  const gap = now - t;
  return gap >= CANARY_MIN_GAP_MS
    ? { ok: true }
    : { ok: false, waitMinutes: Math.ceil((CANARY_MIN_GAP_MS - gap) / 60_000) };
}
