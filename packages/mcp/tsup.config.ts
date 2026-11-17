// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'tsup';

// Workspace packages are bundled so the published binary runs outside the monorepo.
export default defineConfig({
  entry: ['src/index.ts', 'src/bin.ts'],
  format: ['esm'],
  // Bundled workspace types are inlined so the published declarations stand alone.
  dts: { resolve: ['@buiry/core'] },
  clean: true,
  noExternal: ['@buiry/core'],
});
