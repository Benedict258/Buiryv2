// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'tsup';

// Workspace packages are bundled so the published binary runs outside the monorepo.
export default defineConfig({
  entry: ['src/index.ts', 'src/bin.ts'],
  format: ['esm'],
  dts: { resolve: ['@buiry/core', '@buiry/mcp'] },
  clean: true,
  noExternal: ['@buiry/core', '@buiry/mcp'],
});
