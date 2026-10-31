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
});
