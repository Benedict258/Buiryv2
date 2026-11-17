import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@buiry/core': p('./packages/core/src/index.ts'),
      '@buiry/storage': p('./packages/storage/src/index.ts'),
      '@buiry/chain': p('./packages/chain/src/index.ts'),
      '@buiry/mcp': p('./packages/mcp/src/index.ts'),
      '@buiry/api': p('./packages/api/src/index.ts'),
      '@buiry/worker': p('./packages/worker/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'scripts/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    // PGlite-backed suites build a fresh database per test; under a full parallel run on a slow machine they
    // approached 20 s and timed out at random (seen 2026-11-17). Tests still fail fast on real errors.
    testTimeout: 60000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      reporter: ['text-summary', 'json-summary'],
    },
  },
});
