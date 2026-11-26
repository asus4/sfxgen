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
        // Without `sfxgen serve` running, a read is answered quietly (204, no JSON): the editor then works on its own,
        // and the console stays free of proxy errors. A write must fail out loud instead: a 204 would look like a
        // save, and the change would be lost.
        configure(proxy) {
          proxy.on('error', (_err, req, res) => {
            if (!('writeHead' in res) || res.headersSent) return;
            if (req.method === 'GET' || req.method === 'HEAD') {
              res.writeHead(204);
              res.end();
              return;
            }
            res.writeHead(503, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'the sfxgen server is not running (port 5179), so nothing was saved: start it, then make the change again' }));
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
