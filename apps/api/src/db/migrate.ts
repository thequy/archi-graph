// Applies the versioned-graph schema to a Postgres database.
//
// Order matters: the pgvector extension MUST be created before the migrations
// run, because doc_chunks.embedding uses the `vector(768)` type.
//
// Usage:
//   DATABASE_URL=postgres://... npm run -w apps/api db:migrate
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { resolve } from 'node:path';

// src/db -> apps/api/drizzle (compiled output keeps the same relative depth).
const MIGRATIONS_FOLDER = resolve(__dirname, '..', '..', 'drizzle');

// Fixed advisory-lock key serializing concurrent runMigrations() callers so a
// simultaneous `CREATE EXTENSION IF NOT EXISTS vector` cannot race on
// pg_extension. Arbitrary constant, unique to this migration path.
const MIGRATION_LOCK_KEY = 735_421_900;

/**
 * Creates the vector extension and applies all Drizzle migrations.
 * @param connectionString defaults to DATABASE_URL, then the podman test DB.
 */
export async function runMigrations(connectionString?: string): Promise<void> {
  const url =
    connectionString ??
    process.env.DATABASE_URL ??
    'postgres://postgres:postgres@localhost:5433/archigraph';

  const pool = new Pool({ connectionString: url });
  try {
    // Serialize concurrent migrators with a Postgres advisory lock.
    //
    // `CREATE EXTENSION IF NOT EXISTS vector` is NOT safe under concurrency:
    // two callers that pass the IF-NOT-EXISTS check at the same time race to
    // INSERT into pg_extension and one fails with a unique_violation. In the
    // compose stack the api is the ONLY migrator (the worker waits for the
    // schema and never migrates), but we ALSO take a session advisory lock so
    // that even if two migrators ever run at once they SERIALIZE rather than
    // race.
    //
    // The lock MUST be acquired, held, and released on ONE dedicated
    // connection: pg_advisory_lock is session-scoped, and a pooled `execute`
    // may run on a different backend each call. So we check out a single
    // client, run the whole migration on it, and release on that same client.
    const client = await pool.connect();
    try {
      const db = drizzle(client);
      await db.execute(sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY});`);
      try {
        // pgvector must exist before the migration references vector(768).
        await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector;`);
        await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      } finally {
        await db.execute(sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY});`);
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

// Allow running directly as a script (`tsx src/db/migrate.ts`).
if (require.main === module) {
  runMigrations()
    .then(() => {
      // eslint-disable-next-line no-console
      console.log('Migrations applied.');
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
