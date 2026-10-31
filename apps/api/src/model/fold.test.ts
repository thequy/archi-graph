import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, closeDb, type Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { foldHeadState } from './fold';
import { ensureMainBranch, CommitService } from './commit.service';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5433/archigraph';

let db: Db;

beforeAll(async () => {
  await runMigrations(DATABASE_URL);
  db = getDb(DATABASE_URL);
}, 60_000);

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE
    embedding_jobs, doc_chunks,
    head_relations, head_entities,
    relation_versions, entity_versions,
    commits, branches RESTART IDENTITY CASCADE`);
});

describe('foldHeadState', () => {
  it('returns empty head-state for a fresh branch', async () => {
    const branchId = await ensureMainBranch(db);
    const head = await foldHeadState(db, branchId);
    expect(head.entities).toEqual([]);
    expect(head.relations).toEqual([]);
  });

  it('isolates head-state per branch', async () => {
    const branchId = await ensureMainBranch(db);
    const service = new CommitService(db);
    await service.commit(
      branchId,
      {
        entities: [
          {
            op: 'add',
            entity: {
              entityId: 'E1',
              type: 'brd',
              code: 'C',
              shortTitle: 's',
              group: 'soe',
              tier: 't0',
              title: 't',
              metadata: {
                author: 'local',
                date: '2026-01-01',
                status: 'd',
                tags: [],
              },
              contentMarkdown: 'x',
              flow: null,
              links: [],
            },
          },
        ],
        relations: [],
      },
      'seed',
    );

    // A different, non-existent branch id has no head-state.
    const other = '00000000-0000-0000-0000-000000000000';
    const head = await foldHeadState(db, other);
    expect(head.entities).toEqual([]);
    expect(head.relations).toEqual([]);
  });
});
