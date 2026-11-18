import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Phase 5.4, sweep A13: a database connection error at startup used to print the user, host and port
// ("password authentication failed for user ...", "getaddrinfo ENOTFOUND <host>", "connect ECONNREFUSED <ip>:<port>",
// seen on a throwaway Postgres 16 on 2026-11-18). Startup now reports the class and code only.
const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

describe('A13: startup failure text', () => {
  it('reports a database connection failure by class and code, without the host, port or user', () => {
    const r = spawnSync(
      process.execPath,
      [resolve(ROOT, 'node_modules/tsx/dist/cli.mjs'), resolve(ROOT, 'packages/worker/src/bin.ts')],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          DATABASE_URL: 'postgres://user-marker:pw-marker@127.0.0.1:1/buiry_test',
          PORT: '0',
          NODE_ENV: 'development',
        },
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status, out).toBe(1);
    expect(out).toContain('[buiry] failed to start: {"error":"Error","code":"ECONNREFUSED"}');
    for (const detail of ['127.0.0.1', 'user-marker', 'pw-marker']) expect(out).not.toContain(detail);
  }, 90_000);
});
