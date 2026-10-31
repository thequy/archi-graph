// Tests for BranchService.createCandidate — a candidate branch must COPY the
// parent's head-state at creation into its OWN per-branch head tables, and be
// fully ISOLATED afterwards: later commits on the parent must not touch the
// candidate, and vice-versa (Global Constraint: head tables independent per
// branch_id). parent_commit_id is pinned to the parent's head at creation.
//
// Runs against a REAL Postgres+pgvector (podman). Serialized api suites.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Entity, Relation } from '@archi-graph/shared';
import { getDb, closeDb, type Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { branches } from '../db/schema';
import { CommitService, ensureMainBranch, BranchNotFoundError } from '../model/commit.service';
import { foldHeadState } from '../model/fold';
import { BranchService } from './branch.service';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5433/archigraph';

let db: Db;
let commits: CommitService;
let service: BranchService;

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
  const { sql } = await import('drizzle-orm');
  await db.execute(
    sql`TRUNCATE TABLE
      embedding_jobs, doc_chunks,
      head_relations, head_entities,
      relation_versions, entity_versions,
      commits, branches RESTART IDENTITY CASCADE`,
  );
}

async function seedMain(): Promise<string> {
  const branchId = await ensureMainBranch(db);
  await commits.commit(
    branchId,
    {
      entities: [
        { op: 'add', entity: makeEntity({ entityId: 'E1', code: 'BRD-1' }) },
        { op: 'add', entity: makeEntity({ entityId: 'E2', code: 'SAD-1', type: 'sad' }) },
      ],
      relations: [
        {
          op: 'add',
          relation: makeRelation({
            relationId: 'R1',
            sourceEntityId: 'E1',
            targetEntityId: 'E2',
          }),
        },
      ],
    },
    'seed main',
  );
  return branchId;
}

function sortedIds<T extends { entityId?: string; relationId?: string }>(
  arr: T[],
  key: 'entityId' | 'relationId',
): string[] {
  return arr.map((x) => x[key] as string).sort();
}

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  await runMigrations(DATABASE_URL);
  db = getDb(DATABASE_URL);
  commits = new CommitService(db);
  service = new BranchService(db);
}, 60_000);

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
});

describe('BranchService.createCandidate', () => {
  it('candidate graph equals parent graph at creation', async () => {
    const mainId = await seedMain();
    const { branchId: candId } = await service.createCandidate('cand', mainId);

    const parentHead = await foldHeadState(db, mainId);
    const candHead = await foldHeadState(db, candId);

    expect(sortedIds(candHead.entities, 'entityId')).toEqual(
      sortedIds(parentHead.entities, 'entityId'),
    );
    expect(sortedIds(candHead.relations, 'relationId')).toEqual(
      sortedIds(parentHead.relations, 'relationId'),
    );
    // Deep payload copy, not just ids.
    const candE1 = candHead.entities.find((e) => e.entityId === 'E1');
    expect(candE1).toMatchObject({ code: 'BRD-1', type: 'brd', title: 'Title' });
  });

  it('pins parent_commit_id to the parent head_commit_id at creation', async () => {
    const mainId = await seedMain();
    const [parent] = await db
      .select()
      .from(branches)
      .where(eq(branches.id, mainId));
    const parentHeadCommit = parent.headCommitId;

    const { branchId: candId } = await service.createCandidate('cand', mainId);
    const [cand] = await db
      .select()
      .from(branches)
      .where(eq(branches.id, candId));

    expect(cand.parentCommitId).toBe(parentHeadCommit);
    expect(cand.name).toBe('cand');
    // Candidate's own head starts at the pinned parent commit.
    expect(cand.headCommitId).toBe(parentHeadCommit);
  });

  it('later commit on PARENT does not change the candidate', async () => {
    const mainId = await seedMain();
    const { branchId: candId } = await service.createCandidate('cand', mainId);

    // Mutate the parent AFTER branching.
    await commits.commit(
      mainId,
      {
        entities: [{ op: 'add', entity: makeEntity({ entityId: 'E99', code: 'LATE' }) }],
        relations: [],
      },
      'late add on parent',
    );

    const candHead = await foldHeadState(db, candId);
    expect(sortedIds(candHead.entities, 'entityId')).toEqual(['E1', 'E2']);
    expect(candHead.entities.some((e) => e.entityId === 'E99')).toBe(false);

    const parentHead = await foldHeadState(db, mainId);
    expect(sortedIds(parentHead.entities, 'entityId')).toEqual(['E1', 'E2', 'E99']);
  });

  it('later commit on CANDIDATE does not change the parent', async () => {
    const mainId = await seedMain();
    const { branchId: candId } = await service.createCandidate('cand', mainId);

    await commits.commit(
      candId,
      {
        entities: [{ op: 'add', entity: makeEntity({ entityId: 'C1', code: 'ONLYCAND' }) }],
        relations: [],
      },
      'add on candidate',
    );

    const parentHead = await foldHeadState(db, mainId);
    expect(sortedIds(parentHead.entities, 'entityId')).toEqual(['E1', 'E2']);
    expect(parentHead.entities.some((e) => e.entityId === 'C1')).toBe(false);

    const candHead = await foldHeadState(db, candId);
    expect(sortedIds(candHead.entities, 'entityId')).toEqual(['C1', 'E1', 'E2']);
  });

  it('throws BranchNotFoundError when fromBranchId does not exist', async () => {
    await ensureMainBranch(db);
    const missing = '00000000-0000-0000-0000-000000000000';
    await expect(service.createCandidate('cand', missing)).rejects.toBeInstanceOf(
      BranchNotFoundError,
    );
  });

  it('listBranches returns created branches', async () => {
    const mainId = await seedMain();
    await service.createCandidate('cand-a', mainId);
    await service.createCandidate('cand-b', mainId);

    const list = await service.listBranches();
    const names = list.map((b) => b.name).sort();
    expect(names).toEqual(['cand-a', 'cand-b', 'main']);
  });
});
