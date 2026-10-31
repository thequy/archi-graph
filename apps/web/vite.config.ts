/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `@archi-graph/shared` is consumed as RAW TS SOURCE: its package.json `exports`
// field points at `./src/index.ts` (no build step). Vite's dependency optimizer
// normally pre-bundles node_modules, which would choke on a bare `.ts` entry, so
// we exclude it from optimization and let esbuild transpile it as part of the
// app graph. Being a workspace symlink, Vite resolves it through the normal
// module graph — no resolve.alias / vendor-copy needed.
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['@archi-graph/shared'],
  },
  server: {
    port: 5173,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
