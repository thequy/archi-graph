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
    const db = drizzle(pool);
    // pgvector must exist before the migration references vector(768).
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector;`);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
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
