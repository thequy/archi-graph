// Shared boot helpers for the compose stack: schema migration + idempotent
// seed, plus a "wait for schema" gate the worker uses.
//
// WHO RUNS WHAT (the single-migrator rule):
//   - The API container runs `prepareApiDatabase()` on boot: it applies the
//     migrations (with the advisory lock in runMigrations) and seeds the POC
//     dataset ONCE. It is the ONLY migrator.
//   - The worker container runs `waitForSchema()` and NEVER migrates/seeds —
//     this is what avoids the concurrent `CREATE EXTENSION` race described in
//     the build ledger: only one process ever issues the extension/DDL.
//
// SEED IDEMPOTENCE (survives restarts):
//   `ensureMainBranch` is already idempotent re: the branch row. The seed guard
//   here adds the missing piece: we skip importPocSeed when `main`'s head-state
//   already holds entities. So a container restart (or a second api replica)
//   does NOT double-commit the 60 docs / 45 relations — it detects a non-empty
//   main head and returns `skipped`.

import { sql } from 'drizzle-orm';
import { getDb, type Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { ensureMainBranch } from '../model/commit.service';
import { foldHeadState } from '../model/fold';
import { importPocSeed } from '../import/poc-import';

export interface PrepareResult {
  migrated: true;
  seed: 'imported' | 'skipped';
  entities: number;
  relations: number;
}

/** Simple async sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Applies migrations then seeds the POC dataset into `main` exactly once.
 * Idempotent across restarts: if `main` already has entities in its head-state,
 * the seed is skipped (no duplicate commit).
 *
 * @param connectionString optional DB url override (defaults to DATABASE_URL via getDb()).
 */
export async function prepareApiDatabase(
  connectionString?: string,
): Promise<PrepareResult> {
  // 1. Migrate (advisory-locked; creates the vector extension + schema).
  await runMigrations(connectionString ?? process.env.DATABASE_URL);

  // 2. Ensure main exists, then seed-guard on its current head-state.
  const db = getDb(connectionString ?? process.env.DATABASE_URL);
  const mainBranchId = await ensureMainBranch(db);
  const head = await foldHeadState(db, mainBranchId);

  if (head.entities.length > 0) {
    return {
      migrated: true,
      seed: 'skipped',
      entities: head.entities.length,
      relations: head.relations.length,
    };
  }

  const imported = await importPocSeed(db);
  return {
    migrated: true,
    seed: 'imported',
    entities: imported.entities,
    relations: imported.relations,
  };
}

/**
 * Blocks until the versioned-graph schema exists (the api has finished
 * migrating). The worker calls this BEFORE its indexing loop so it never
 * touches a half-built schema and never migrates itself.
 *
 * Polls for the presence of the `embedding_jobs` table (the worker's own input
 * table) via to_regclass, which returns NULL until the table exists.
 *
 * @param connectionString DB url (defaults to DATABASE_URL).
 * @param timeoutMs give up after this long (default 120s).
 * @param intervalMs poll cadence (default 2s).
 */
export async function waitForSchema(
  connectionString?: string,
  timeoutMs = 120_000,
  intervalMs = 2_000,
): Promise<void> {
  const db: Db = getDb(connectionString ?? process.env.DATABASE_URL);
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await db.execute(
        sql`SELECT to_regclass('public.embedding_jobs') AS t;`,
      );
      const present = (res.rows as Array<{ t: string | null }>)[0]?.t;
      if (present) return;
    } catch {
      // DB not reachable yet — fall through to retry.
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForSchema: embedding_jobs not present after ${timeoutMs}ms`,
      );
    }
    await sleep(intervalMs);
  }
}
