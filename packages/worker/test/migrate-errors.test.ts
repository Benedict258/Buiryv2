import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/migrate.js';

// Phase 8 B3, sweep A9: a failed migration run used to print the raw error. A connection failure names the database
// user, host and port (the same leak as A13). It now prints the error class and code only.
afterEach(() => vi.restoreAllMocks());

describe('A9: migration failure text', () => {
  it('reports a connection failure by class and code, without host, port or user', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation(
      (...a: unknown[]) => void lines.push(a.map(String).join(' ')),
    );
    const code = await runMigrations({
      DATABASE_URL: 'postgres://user-marker:pw-marker@127.0.0.1:1/buiry_test',
    });
    expect(code).toBe(1);
    const out = lines.join('\n');
    expect(out).toContain('[buiry] migration failed: {"error":"Error","code":"ECONNREFUSED"}');
    for (const detail of ['127.0.0.1', 'user-marker', 'pw-marker']) expect(out).not.toContain(detail);
  }, 60_000);
});
