import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  // NestJS DI + class-validator rely on `design:paramtypes` /
  // `emitDecoratorMetadata`, which vitest's default esbuild transform does NOT
  // emit. The swc plugin compiles the TS with decorator metadata so that
  // constructor injection and ValidationPipe DTO inference work under test.
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
        },
      },
    }),
  ],
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
