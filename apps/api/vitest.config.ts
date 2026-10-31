import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // The suites share one Postgres (migrations + TRUNCATE between tests).
    // Run files sequentially in a single worker so concurrent runMigrations
    // calls cannot race (e.g. "CREATE EXTENSION IF NOT EXISTS vector"
    // colliding on the pg_extension catalog) and so cross-suite TRUNCATE
    // state stays deterministic.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
