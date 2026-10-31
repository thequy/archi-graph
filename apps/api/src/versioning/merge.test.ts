// Tests for three-way merge (mergeCandidate) — entity/relation-level +
// referential conflicts.
//
// Runs against a REAL Postgres+pgvector (podman). beforeAll applies migrations
// and ensures `main`; tables are truncated between tests for determinism.
// (api suites are serialized via vitest.config fileParallelism:false.)
//
// Merge model (see merge.ts header): three-way vs the common ancestor (base),
// which is the parent branch's head-state AT the candidate's pinned
// parent_commit_id, reconstructed by folding the version tables along the
// commit ancestry (foldStateAtCommit).
//
// Review Focus (Global Constraint): the merged result must NEVER contain a
// relation whose source/target entity is absent — a relation added on one side
// pointing at an entity deleted on the other is a `referential` conflict.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Entity, Relation } from '@archi-graph/shared';
import { getDb, closeDb, type Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { CommitService, ensureMainBranch } from '../model/commit.service';
import { foldHeadState } from '../model/fold';
import { BranchService } from './branch.service';
import { mergeCandidate, foldStateAtCommit } from './merge';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5433/archigraph';

let db: Db;
let commits: CommitService;
let branchService: BranchService;

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

/** Seed `main` with two entities + one relation E1->E2, return its branchId. */
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

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  await runMigrations(DATABASE_URL);
  db = getDb(DATABASE_URL);
  commits = new CommitService(db);
  branchService = new BranchService(db);
}, 60_000);

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
});

describe('foldStateAtCommit', () => {
  it('reconstructs the parent head-state at the pinned fork commit', async () => {
    const mainId = await ensureMainBranch(db);
    const { commitId: c1 } = await commits.commit(
      mainId,
      {
        entities: [{ op: 'add', entity: makeEntity({ entityId: 'E1' }) }],
        relations: [],
      },
      'c1',
    );
    // Second commit updates E1 and adds E2.
    await commits.commit(
      mainId,
      {
        entities: [
          { op: 'update', entity: makeEntity({ entityId: 'E1', title: 'V2' }) },
          { op: 'add', entity: makeEntity({ entityId: 'E2' }) },
        ],
        relations: [],
      },
      'c2',
    );

    // At c1, only E1 existed with its original title.
    const atC1 = await foldStateAtCommit(db, c1);
    expect(atC1.entities.map((e) => e.entityId).sort()).toEqual(['E1']);
    expect(atC1.entities[0].title).toBe('Title');

    // Current head equals the main branch head-state.
    const current = await foldHeadState(db, mainId);
    expect(current.entities.map((e) => e.entityId).sort()).toEqual(['E1', 'E2']);
    expect(current.entities.find((e) => e.entityId === 'E1')?.title).toBe('V2');
  });
});

describe('mergeCandidate', () => {
  it('non-conflicting disjoint changes ⇒ clean; merged head-state is the union', async () => {
    const mainId = await seedMain();
    const { branchId: candId } = await branchService.createCandidate(
      'cand',
      mainId,
    );

    // main side: add E3.
    await commits.commit(
      mainId,
      {
        entities: [{ op: 'add', entity: makeEntity({ entityId: 'E3', code: 'M3' }) }],
        relations: [],
      },
      'main adds E3',
    );
    // candidate side: add E4.
    await commits.commit(
      candId,
      {
        entities: [{ op: 'add', entity: makeEntity({ entityId: 'E4', code: 'C4' }) }],
        relations: [],
      },
      'cand adds E4',
    );

    const result = await mergeCandidate(db, candId, {});
    expect(result.status).toBe('clean');

    const head = await foldHeadState(db, mainId);
    expect(head.entities.map((e) => e.entityId).sort()).toEqual([
      'E1',
      'E2',
      'E3',
      'E4',
    ]);
    // Relation R1 preserved.
    expect(head.relations.map((r) => r.relationId)).toEqual(['R1']);
  });

  it('changed on candidate side only ⇒ auto-takes candidate (theirs)', async () => {
    const mainId = await seedMain();
    const { branchId: candId } = await branchService.createCandidate(
      'cand',
      mainId,
    );

    await commits.commit(
      candId,
      {
        entities: [
          { op: 'update', entity: makeEntity({ entityId: 'E1', title: 'CandTitle' }) },
        ],
        relations: [],
      },
      'cand edits E1',
    );

    const result = await mergeCandidate(db, candId, {});
    expect(result.status).toBe('clean');

    const head = await foldHeadState(db, mainId);
    expect(head.entities.find((e) => e.entityId === 'E1')?.title).toBe(
      'CandTitle',
    );
  });

  it('same entity edited differently on both ⇒ one entity conflict; resolve theirs ⇒ clean w/ candidate version', async () => {
    const mainId = await seedMain();
    const { branchId: candId } = await branchService.createCandidate(
      'cand',
      mainId,
    );

    await commits.commit(
      mainId,
      {
        entities: [
          { op: 'update', entity: makeEntity({ entityId: 'E1', title: 'MainTitle' }) },
        ],
        relations: [],
      },
      'main edits E1',
    );
    await commits.commit(
      candId,
      {
        entities: [
          { op: 'update', entity: makeEntity({ entityId: 'E1', title: 'CandTitle' }) },
        ],
        relations: [],
      },
      'cand edits E1',
    );

    const conflictResult = await mergeCandidate(db, candId, {});
    expect(conflictResult.status).toBe('conflict');
    if (conflictResult.status !== 'conflict') return;
    expect(conflictResult.conflicts).toHaveLength(1);
    expect(conflictResult.conflicts[0].kind).toBe('entity');
    expect(conflictResult.conflicts[0].id).toBe('E1');
    expect((conflictResult.conflicts[0].ours as Entity).title).toBe('MainTitle');
    expect((conflictResult.conflicts[0].theirs as Entity).title).toBe(
      'CandTitle',
    );

    // Resolve by taking theirs (candidate).
    const resolved = await mergeCandidate(db, candId, {
      resolutions: { E1: 'theirs' },
    });
    expect(resolved.status).toBe('clean');

    const head = await foldHeadState(db, mainId);
    expect(head.entities.find((e) => e.entityId === 'E1')?.title).toBe(
      'CandTitle',
    );
  });

  it('incomplete resolutions still returns conflict', async () => {
    const mainId = await seedMain();
    const { branchId: candId } = await branchService.createCandidate(
      'cand',
      mainId,
    );

    // Two conflicting entities: E1 and E2.
    await commits.commit(
      mainId,
      {
        entities: [
          { op: 'update', entity: makeEntity({ entityId: 'E1', title: 'M1' }) },
          { op: 'update', entity: makeEntity({ entityId: 'E2', title: 'M2', type: 'sad' }) },
        ],
        relations: [],
      },
      'main edits E1+E2',
    );
    await commits.commit(
      candId,
      {
        entities: [
          { op: 'update', entity: makeEntity({ entityId: 'E1', title: 'C1t' }) },
          { op: 'update', entity: makeEntity({ entityId: 'E2', title: 'C2t', type: 'sad' }) },
        ],
        relations: [],
      },
      'cand edits E1+E2',
    );

    // Resolve only E1 — E2 still conflicts.
    const result = await mergeCandidate(db, candId, {
      resolutions: { E1: 'ours' },
    });
    expect(result.status).toBe('conflict');
    if (result.status !== 'conflict') return;
    expect(result.conflicts.map((c) => c.id).sort()).toEqual(['E2']);
  });

  it('main deletes entity X; candidate adds relation → X ⇒ referential conflict; no orphan relation emitted', async () => {
    const mainId = await seedMain();
    const { branchId: candId } = await branchService.createCandidate(
      'cand',
      mainId,
    );

    // main deletes E2 (and its referencing relation R1 so main head stays clean).
    await commits.commit(
      mainId,
      {
        entities: [{ op: 'delete', entity: makeEntity({ entityId: 'E2' }) }],
        relations: [{ op: 'delete', relation: makeRelation({ relationId: 'R1' }) }],
      },
      'main deletes E2 + R1',
    );
    // candidate adds a NEW relation R2 pointing E1 -> E2.
    await commits.commit(
      candId,
      {
        entities: [],
        relations: [
          {
            op: 'add',
            relation: makeRelation({
              relationId: 'R2',
              sourceEntityId: 'E1',
              targetEntityId: 'E2',
              label: 'depends',
            }),
          },
        ],
      },
      'cand adds R2 -> E2',
    );

    const result = await mergeCandidate(db, candId, {});
    expect(result.status).toBe('conflict');
    if (result.status !== 'conflict') return;
    const referential = result.conflicts.filter((c) => c.kind === 'referential');
    expect(referential).toHaveLength(1);
    expect(referential[0].id).toBe('R2');

    // No merge commit should have been produced: main head still lacks R2 and E2.
    const head = await foldHeadState(db, mainId);
    expect(head.relations.map((r) => r.relationId)).not.toContain('R2');
    expect(head.entities.map((e) => e.entityId)).not.toContain('E2');
    // And crucially there is no relation whose endpoint is missing.
    const entityIds = new Set(head.entities.map((e) => e.entityId));
    for (const r of head.relations) {
      expect(entityIds.has(r.sourceEntityId)).toBe(true);
      expect(entityIds.has(r.targetEntityId)).toBe(true);
    }
  });
});
