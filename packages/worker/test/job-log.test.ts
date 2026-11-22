import { describe, expect, it } from 'vitest';
import { jobFailureLine, jobRunLine } from '../src/scheduler.js';

// Phase 9 E2: every job run leaves one structured line (name, outcome, duration, error class) so failures and slow
// jobs can be counted later. The existing "[buiry] job <name> failed" line stays: the job-failures alarm matches it.

describe('job run log', () => {
  it('a successful run: name, ok and duration', () => {
    expect(JSON.parse(jobRunLine({ name: 'drift-scan', ok: true, ms: 42 }))).toEqual({
      level: 'info',
      event: 'job',
      name: 'drift-scan',
      ok: true,
      ms: 42,
    });
  });

  it('a failed run: the error class and code only, as the failure line has them', () => {
    const error = JSON.stringify({ error: 'DatabaseError', code: '57P01' });
    expect(JSON.parse(jobRunLine({ name: 'renewal', ok: false, ms: 7, error }))).toEqual({
      level: 'error',
      event: 'job',
      name: 'renewal',
      ok: false,
      ms: 7,
      error: { error: 'DatabaseError', code: '57P01' },
    });
  });

  it('the failure line the alarm matches is unchanged', () => {
    expect(jobFailureLine('renewal', '{"error":"Error"}')).toBe(
      '[buiry] job renewal failed: {"error":"Error"}',
    );
  });
});
