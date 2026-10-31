// Drizzle client bound to DATABASE_URL.
// Driver choice: node-postgres (`pg`) — the standard, best-supported driver for
// Drizzle's postgres-js/node-postgres path and the one Drizzle documents first.
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from './schema';

export type Db = NodePgDatabase<typeof schema>;

let pool: Pool | undefined;
let db: Db | undefined;

/**
 * Returns a singleton Drizzle instance bound to DATABASE_URL.
 * @param connectionString optional override (defaults to process.env.DATABASE_URL)
 */
export function getDb(connectionString?: string): Db {
  if (db) return db;
  const url = connectionString ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set');
  }
  pool = new Pool({ connectionString: url });
  db = drizzle(pool, { schema });
  return db;
}

/** Closes the pooled connection (used by scripts/tests). */
export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
  db = undefined;
}
