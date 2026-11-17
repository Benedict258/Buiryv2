import { defineConfig } from 'tsup';

// Production server bundle (the container image runs this, not tsx). Workspace code is inlined; every third-party
// package stays external and comes from the image's production node_modules (installed with a hoisted layout).
export default defineConfig({
  entry: { server: 'src/bin.ts', migrate: 'src/migrate.ts' },
  outDir: 'dist-server',
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  clean: true,
  sourcemap: true,
  dts: false,
  noExternal: [/^@buiry\//],
  external: [/^[a-z]/, /^@(?!buiry\/)/],
});
