import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { runMigrations } from './migrate';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5433/archigraph';

const EXPECTED_TABLES = [
  'branches',
  'commits',
  'entity_versions',
  'relation_versions',
  'head_entities',
  'head_relations',
  'doc_chunks',
  'embedding_jobs',
] as const;

let client: Client;

beforeAll(async () => {
  // Apply schema + vector extension to the disposable Postgres.
  await runMigrations(DATABASE_URL);
  client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
}, 60_000);

afterAll(async () => {
  await client?.end();
});

describe('versioned-graph schema migration', () => {
  it('creates all 8 required tables', async () => {
    const res = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [EXPECTED_TABLES as unknown as string[]],
    );
    const found = res.rows.map((r) => r.table_name).sort();
    expect(found).toEqual([...EXPECTED_TABLES].sort());
  });

  it('installs the vector extension', async () => {
    const res = await client.query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname = 'vector'`,
    );
    expect(res.rows.map((r) => r.extname)).toContain('vector');
  });

  it('stores entity_versions.metadata_json as jsonb', async () => {
    const res = await client.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'entity_versions'
         AND column_name = 'metadata_json'`,
    );
    expect(res.rows[0]?.data_type).toBe('jsonb');
  });

  // --- Core versioning invariants (pinned against future drizzle-kit regens) ---

  // Returns the ordered list of columns forming a table's PRIMARY KEY,
  // read from the live catalog (table_constraints + key_column_usage).
  async function primaryKeyColumns(tableName: string): Promise<string[]> {
    const res = await client.query<{ column_name: string }>(
      `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.table_schema = 'public'
          AND tc.table_name = $1
          AND tc.constraint_type = 'PRIMARY KEY'
        ORDER BY kcu.ordinal_position`,
      [tableName],
    );
    return res.rows.map((r) => r.column_name);
  }

  it('head_entities primary key is exactly (branch_id, entity_id)', async () => {
    expect(await primaryKeyColumns('head_entities')).toEqual([
      'branch_id',
      'entity_id',
    ]);
  });

  it('head_relations primary key is exactly (branch_id, relation_id)', async () => {
    expect(await primaryKeyColumns('head_relations')).toEqual([
      'branch_id',
      'relation_id',
    ]);
  });

  it('doc_chunks has a UNIQUE constraint on (entity_id, commit_id, chunk_index)', async () => {
    // Find every UNIQUE constraint on doc_chunks and its ordered columns,
    // then assert one of them covers exactly the expected triple.
    const res = await client.query<{
      constraint_name: string;
      column_name: string;
      ordinal_position: number;
    }>(
      `SELECT tc.constraint_name, kcu.column_name, kcu.ordinal_position
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'doc_chunks'
          AND tc.constraint_type = 'UNIQUE'
        ORDER BY tc.constraint_name, kcu.ordinal_position`,
    );

    const byConstraint = new Map<string, string[]>();
    for (const row of res.rows) {
      const cols = byConstraint.get(row.constraint_name) ?? [];
      cols.push(row.column_name);
      byConstraint.set(row.constraint_name, cols);
    }

    const uniqueColumnSets = [...byConstraint.values()];
    expect(uniqueColumnSets).toContainEqual([
      'entity_id',
      'commit_id',
      'chunk_index',
    ]);
  });

  it("defaults author to 'local' on versioned tables", async () => {
    const res = await client.query<{
      table_name: string;
      column_default: string | null;
    }>(
      `SELECT table_name, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name = 'author'
          AND table_name = ANY($1::text[])`,
      [['entity_versions', 'branches']],
    );

    const defaults = new Map(
      res.rows.map((r) => [r.table_name, r.column_default]),
    );
    // column_default is rendered as the quoted literal expression, e.g. 'local'::text
    expect(defaults.get('entity_versions')).toMatch(/^'local'::text$/);
    expect(defaults.get('branches')).toMatch(/^'local'::text$/);
  });

  it('doc_chunks.embedding is vector(768)', async () => {
    // format_type(atttypid, atttypmod) renders the full type incl. dimension.
    const res = await client.query<{ formatted_type: string }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS formatted_type
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'doc_chunks'
          AND a.attname = 'embedding'
          AND a.attnum > 0
          AND NOT a.attisdropped`,
    );
    expect(res.rows[0]?.formatted_type).toBe('vector(768)');
  });
});
