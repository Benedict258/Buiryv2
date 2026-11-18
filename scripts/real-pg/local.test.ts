import { describe, expect, it } from 'vitest';
import { assertLocalDatabase } from './local.js';

// Phase 5.3: the seed and key-check scripts refuse a non-local database unless explicitly allowed.
describe('real-Postgres scripts: local database guard', () => {
  it('accepts local hosts and refuses others without BUIRY_SEED_ALLOW_REMOTE=1', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]'])
      expect(() => assertLocalDatabase(`postgres://u:p@${host}:55432/buiry_seed`, {})).not.toThrow();
    expect(() => assertLocalDatabase('postgres://u:p@db.internal:5432/buiry', {})).toThrow(/not local/);
    expect(() =>
      assertLocalDatabase('postgres://u:p@db.internal:5432/buiry', { BUIRY_SEED_ALLOW_REMOTE: '1' }),
    ).not.toThrow();
  });
});
