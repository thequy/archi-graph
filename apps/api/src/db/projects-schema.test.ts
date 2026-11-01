// Projects-extension backfill migration — the critical case is that the
// migration adopts PRE-EXISTING v1 data (a branch seeded while the schema had
// no `project_id` at all) into a single default project, and only THEN makes
// `branches.project_id` NOT NULL + FK. Running the NOT NULL step while a branch
// is still unbackfilled is the failure mode this test pins.
//
// To reproduce "pre-existing v1 data" faithfully we bring the DB up at the v1
// schema state (apply only the first migration, 0000), hand-insert a `main`
// branch, and THEN run the full runMigrations() — which applies the new
// projects migration + backfill on top of that already-populated branch. This
// is strictly stronger than migrating an empty DB.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runMigrations } from './migrate';
import { DEMO_PROJECT_NAME } from './schema';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5433/archigraph';

const DRIZZLE_DIR = resolve(__dirname, '..', '..', 'drizzle');
const V1_MIGRATION_TAG = '0000_large_scorpion';

let client: Client;
let preExistingBranchId: string;

/**
 * Brings `db` up at the v1 schema state WITHOUT the projects migration:
 *  - create the drizzle migrations bookkeeping table,
 *  - apply the v1 DDL (0000) by hand,
 *  - record 0000 as applied so the later runMigrations() skips it and only
 *    runs the NEW projects migration against the data we seed below.
 */
async function applyV1SchemaOnly(c: Client): Promise<void> {
  await c.query('CREATE EXTENSION IF NOT EXISTS vector;');
  await c.query(`CREATE SCHEMA IF NOT EXISTS drizzle;`);
  await c.query(
    `CREATE TABLE IF NOT EXISTS drizzle."__drizzle_migrations" (
       id SERIAL PRIMARY KEY,
       hash text NOT NULL,
       created_at bigint
     );`,
  );

  const sqlText = readFileSync(
    resolve(DRIZZLE_DIR, `${V1_MIGRATION_TAG}.sql`),
    'utf8',
  );
  // The migrator splits on this breakpoint marker; apply each chunk.
  for (const stmt of sqlText.split('--> statement-breakpoint')) {
    const trimmed = stmt.trim();
    if (trimmed.length > 0) await c.query(trimmed);
  }

  // Record the v1 migration as already applied (hash must match the journal's
  // ordering; drizzle only compares the set of applied hashes by creation
  // order, so recording the 0000 tag is enough to make it skip 0000).
  const journal = JSON.parse(
    readFileSync(resolve(DRIZZLE_DIR, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: Array<{ tag: string; when: number }> };
  const entry = journal.entries.find((e) => e.tag === V1_MIGRATION_TAG)!;
  await c.query(
    `INSERT INTO drizzle."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
    [hashOfMigration(V1_MIGRATION_TAG), entry.when],
  );
}

// drizzle hashes the raw SQL file text (sha256) as the migration identity.
function hashOfMigration(tag: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('node:crypto');
  const sqlText = readFileSync(resolve(DRIZZLE_DIR, `${tag}.sql`), 'utf8');
  return createHash('sha256').update(sqlText).digest('hex');
}

beforeAll(async () => {
  const admin = new Client({ connectionString: DATABASE_URL });
  await admin.connect();
  // Pristine DB: drop everything so we start from true v1 bring-up.
  await admin.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
  await admin.query(`DROP SCHEMA IF EXISTS drizzle CASCADE;`);

  await applyV1SchemaOnly(admin);

  // Seed a PRE-EXISTING branch while there is NO project_id column at all.
  const ins = await admin.query<{ id: string }>(
    `INSERT INTO branches (name, author) VALUES ('main', 'local') RETURNING id`,
  );
  preExistingBranchId = ins.rows[0].id;
  await admin.end();

  // Now run the real migrator: it applies ONLY the projects migration +
  // backfill on top of the pre-existing branch.
  await runMigrations(DATABASE_URL);

  client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
}, 60_000);

afterAll(async () => {
  await client?.end();
});

describe('projects-extension migration (backfill over pre-existing v1 data)', () => {
  it('creates the projects table', async () => {
    const res = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'projects'`,
    );
    expect(res.rows.map((r) => r.table_name)).toContain('projects');
  });

  it('seeds exactly one project named CorpDigi', async () => {
    const res = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM projects WHERE name = $1`,
      [DEMO_PROJECT_NAME],
    );
    expect(res.rows[0].n).toBe('1');
  });

  it('backfills the pre-existing branch with a non-null project_id = CorpDigi', async () => {
    const res = await client.query<{ project_id: string | null }>(
      `SELECT project_id FROM branches WHERE id = $1`,
      [preExistingBranchId],
    );
    expect(res.rows).toHaveLength(1);
    const projectId = res.rows[0].project_id;
    expect(projectId).not.toBeNull();

    const proj = await client.query<{ id: string }>(
      `SELECT id FROM projects WHERE name = $1`,
      [DEMO_PROJECT_NAME],
    );
    expect(projectId).toBe(proj.rows[0].id);
  });

  it('makes branches.project_id NOT NULL', async () => {
    const res = await client.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'branches'
          AND column_name = 'project_id'`,
    );
    expect(res.rows[0]?.is_nullable).toBe('NO');
  });

  it('adds a FK branches.project_id -> projects.id', async () => {
    const res = await client.query<{ foreign_table: string }>(
      `SELECT ccu.table_name AS foreign_table
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
         JOIN information_schema.constraint_column_usage ccu
           ON tc.constraint_name = ccu.constraint_name
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'branches'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND kcu.column_name = 'project_id'`,
    );
    expect(res.rows.map((r) => r.foreign_table)).toContain('projects');
  });

  it('adds a project_id column to doc_chunks and embedding_jobs', async () => {
    const res = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'project_id'
          AND table_name = ANY($1::text[])`,
      [['doc_chunks', 'embedding_jobs']],
    );
    const found = res.rows.map((r) => r.table_name).sort();
    expect(found).toEqual(['doc_chunks', 'embedding_jobs']);
  });
});
