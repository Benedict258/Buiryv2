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
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      reporter: ['text-summary', 'json-summary'],
    },
  },
});
