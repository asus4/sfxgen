import { defineConfig } from 'tsup';

// The CLI. The DSP core is bundled in; the web editor is built separately by Vite.
export default defineConfig({
  entry: { cli: 'src/node/cli.ts' },
  outDir: 'dist/node',
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
});
