/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The editor is a static site: `npm run build:web` writes dist/web, which `sfxgen serve` also hosts.
export default defineConfig({
  plugins: [react()],
  base: './',
  worker: { format: 'es' },
  build: { outDir: 'dist/web', emptyOutDir: true, target: 'es2022' },
  // `sfxgen serve --port 5179` provides /api during development; without it the editor works on its own.
  server: {
    port: 5178,
    proxy: {
      '/api': {
        target: 'http://localhost:5179',
        changeOrigin: true,
        // Without `sfxgen serve` running, answer quietly (204, no JSON): the editor then works on its own, and the
        // console stays free of proxy errors.
        configure(proxy) {
          proxy.on('error', (_err, _req, res) => {
            if ('writeHead' in res && !res.headersSent) {
              res.writeHead(204);
              res.end();
            }
          });
        },
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000,
  },
});
