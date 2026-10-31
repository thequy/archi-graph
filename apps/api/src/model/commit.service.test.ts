import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Entity, Relation } from '@archi-graph/shared';
import { getDb, closeDb, type Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { branches } from '../db/schema';
import { foldHeadState } from './fold';
import { CommitService, ensureMainBranch } from './commit.service';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5433/archigraph';

let db: Db;
let service: CommitService;

function makeEntity(overrides: Partial<Entity> & { entityId: string }): Entity {
  return {
    type: 'brd',
    code: 'C1',
    shortTitle: 'short',
    group: 'soe',
    tier: 't0',
    title: 'Title',
    metadata: { author: 'local', date: '2026-01-01', status: 'draft', tags: [] },
    contentMarkdown: '# content',
    flow: null,
    links: [],
    ...overrides,
  };
}

function makeRelation(
  overrides: Partial<Relation> & { relationId: string },
): Relation {
  return {
    sourceEntityId: 'E1',
    targetEntityId: 'E2',
    kind: 'hierarchy',
    label: 'contains',
    ...overrides,
  };
}

async function truncateAll(): Promise<void> {
  // Fresh state so fold-order tests are deterministic.
  await db.execute(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (await import('drizzle-orm')).sql`TRUNCATE TABLE
      embedding_jobs, doc_chunks,
      head_relations, head_entities,
      relation_versions, entity_versions,
      commits, branches RESTART IDENTITY CASCADE`,
  );
}

beforeAll(async () => {
  await runMigrations(DATABASE_URL);
  db = getDb(DATABASE_URL);
  service = new CommitService(db);
}, 60_000);

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
});

describe('CommitService.commit + foldHeadState', () => {
  it('commits two entities + one relation; fold returns exactly them; head advances', async () => {
    const branchId = await ensureMainBranch(db);

    const before = await db
      .select()
      .from(branches)
      .where(eq(branches.id, branchId));
    const headBefore = before[0]?.headCommitId ?? null;

    const e1 = makeEntity({ entityId: 'E1', code: 'BRD-1' });
    const e2 = makeEntity({ entityId: 'E2', code: 'SAD-1', type: 'sad' });
    const r1 = makeRelation({
      relationId: 'R1',
      sourceEntityId: 'E1',
      targetEntityId: 'E2',
    });

    const { commitId } = await service.commit(
      branchId,
      {
        entities: [
          { op: 'add', entity: e1 },
          { op: 'add', entity: e2 },
        ],
        relations: [{ op: 'add', relation: r1 }],
      },
      'seed two entities + relation',
    );

    expect(commitId).toBeTruthy();

    const head = await foldHeadState(db, branchId);
    expect(head.entities.map((e) => e.entityId).sort()).toEqual(['E1', 'E2']);
    expect(head.relations.map((r) => r.relationId)).toEqual(['R1']);

    // Payload round-trips through the materialized head tables.
    const foldedE1 = head.entities.find((e) => e.entityId === 'E1');
    expect(foldedE1).toMatchObject({ code: 'BRD-1', type: 'brd' });
    expect(foldedE1?.metadata).toEqual(e1.metadata);
    expect(head.relations[0]).toMatchObject({
      sourceEntityId: 'E1',
      targetEntityId: 'E2',
      kind: 'hierarchy',
      label: 'contains',
    });

    const after = await db
      .select()
      .from(branches)
      .where(eq(branches.id, branchId));
    expect(after[0]?.headCommitId).toBe(commitId);
    expect(after[0]?.headCommitId).not.toBe(headBefore);
  });

  it('fold-order: delete-then-add resurrects the entity', async () => {
    const branchId = await ensureMainBranch(db);
    const e = makeEntity({ entityId: 'E1' });

    // add
    await service.commit(
      branchId,
      { entities: [{ op: 'add', entity: e }], relations: [] },
      'add E1',
    );
    let head = await foldHeadState(db, branchId);
    expect(head.entities.map((x) => x.entityId)).toEqual(['E1']);

    // delete
    await service.commit(
      branchId,
      { entities: [{ op: 'delete', entity: e }], relations: [] },
      'delete E1',
    );
    head = await foldHeadState(db, branchId);
    expect(head.entities.map((x) => x.entityId)).toEqual([]);

    // add again (resurrection)
    const e2 = makeEntity({ entityId: 'E1', title: 'Resurrected' });
    await service.commit(
      branchId,
      { entities: [{ op: 'add', entity: e2 }], relations: [] },
      'resurrect E1',
    );
    head = await foldHeadState(db, branchId);
    expect(head.entities.map((x) => x.entityId)).toEqual(['E1']);
    expect(head.entities[0]?.title).toBe('Resurrected');
  });

  it('enqueues an embedding_jobs row per entity with non-empty contentMarkdown (add/update)', async () => {
    const branchId = await ensureMainBranch(db);

    const withContent = makeEntity({
      entityId: 'E1',
      contentMarkdown: '# has content',
    });
    const emptyContent = makeEntity({
      entityId: 'E2',
      contentMarkdown: '',
    });

    const { commitId } = await service.commit(
      branchId,
      {
        entities: [
          { op: 'add', entity: withContent },
          { op: 'add', entity: emptyContent },
        ],
        relations: [],
      },
      'seed',
    );

    const { sql } = await import('drizzle-orm');
    const jobs = await db.execute<{ entity_id: string; commit_id: string }>(
      sql`SELECT entity_id, commit_id FROM embedding_jobs`,
    );
    expect(jobs.rows.map((r) => r.entity_id).sort()).toEqual(['E1']);
    expect(jobs.rows[0]?.commit_id).toBe(commitId);
  });

  it('does not enqueue embedding jobs for delete ops', async () => {
    const branchId = await ensureMainBranch(db);
    const e = makeEntity({ entityId: 'E1' });
    await service.commit(
      branchId,
      { entities: [{ op: 'add', entity: e }], relations: [] },
      'add',
    );

    const { sql } = await import('drizzle-orm');
    await db.execute(sql`TRUNCATE TABLE embedding_jobs`);

    await service.commit(
      branchId,
      { entities: [{ op: 'delete', entity: e }], relations: [] },
      'delete',
    );
    const jobs = await db.execute<{ entity_id: string }>(
      sql`SELECT entity_id FROM embedding_jobs`,
    );
    expect(jobs.rows).toHaveLength(0);
  });
});
