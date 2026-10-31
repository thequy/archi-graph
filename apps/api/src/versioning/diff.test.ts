// Tests for diffBranches — compares two branches' head-states into a GraphDiff.
//
// Runs against a REAL Postgres+pgvector (podman). beforeAll applies migrations
// and ensures `main`; tables are truncated between tests for determinism.
// (api suites are serialized via vitest.config fileParallelism:false.)
//
// Review Focus (Global Constraint): a relation whose SOURCE or TARGET endpoint
// changes — not just its label — MUST register as `updated`, never unchanged.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Entity, Relation } from '@archi-graph/shared';
import { getDb, closeDb, type Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { CommitService, ensureMainBranch } from '../model/commit.service';
import { BranchService } from './branch.service';
import { diffBranches } from './diff';

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

/** Seed `main` with two entities + one relation, return its branchId. */
async function seedMain(): Promise<string> {
  const branchId = await ensureMainBranch(db);
  const e1 = makeEntity({ entityId: 'E1', code: 'BRD-1' });
  const e2 = makeEntity({ entityId: 'E2', code: 'SAD-1', type: 'sad' });
  const e3 = makeEntity({ entityId: 'E3', code: 'HLD-1', type: 'hld' });
  const r1 = makeRelation({
    relationId: 'R1',
    sourceEntityId: 'E1',
    targetEntityId: 'E2',
    label: 'contains',
  });
  await commits.commit(
    branchId,
    {
      entities: [
        { op: 'add', entity: e1 },
        { op: 'add', entity: e2 },
        { op: 'add', entity: e3 },
      ],
      relations: [{ op: 'add', relation: r1 }],
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

describe('diffBranches', () => {
  it('identical branches ⇒ empty diff', async () => {
    const mainId = await seedMain();
    const { branchId: candId } = await branchService.createCandidate(
      'cand',
      mainId,
    );

    const diff = await diffBranches(db, mainId, candId);
    expect(diff.entities).toEqual([]);
    expect(diff.relations).toEqual([]);
  });

  it('add one entity on candidate ⇒ 1 added entity', async () => {
    const mainId = await seedMain();
    const { branchId: candId } = await branchService.createCandidate(
      'cand',
      mainId,
    );

    await commits.commit(
      candId,
      {
        entities: [{ op: 'add', entity: makeEntity({ entityId: 'E9', code: 'NEW' }) }],
        relations: [],
      },
      'add E9 on candidate',
    );

    const diff = await diffBranches(db, mainId, candId);
    const added = diff.entities.filter((d) => d.kind === 'added');
    expect(diff.entities).toHaveLength(1);
    expect(added).toHaveLength(1);
    expect(added[0].id).toBe('E9');
    expect(added[0].before).toBeNull();
    expect(added[0].after?.entityId).toBe('E9');
  });

  it('delete an entity on candidate ⇒ 1 deleted entity', async () => {
    const mainId = await seedMain();
    const { branchId: candId } = await branchService.createCandidate(
      'cand',
      mainId,
    );

    // Must drop the relation referencing E2? No — delete E3 (no relation refs).
    await commits.commit(
      candId,
      {
        entities: [{ op: 'delete', entity: makeEntity({ entityId: 'E3' }) }],
        relations: [],
      },
      'delete E3 on candidate',
    );

    const diff = await diffBranches(db, mainId, candId);
    const deleted = diff.entities.filter((d) => d.kind === 'deleted');
    expect(diff.entities).toHaveLength(1);
    expect(deleted).toHaveLength(1);
    expect(deleted[0].id).toBe('E3');
    expect(deleted[0].before?.entityId).toBe('E3');
    expect(deleted[0].after).toBeNull();
  });

  it('update an entity payload field on candidate ⇒ 1 updated entity', async () => {
    const mainId = await seedMain();
    const { branchId: candId } = await branchService.createCandidate(
      'cand',
      mainId,
    );

    await commits.commit(
      candId,
      {
        entities: [
          { op: 'update', entity: makeEntity({ entityId: 'E1', title: 'Changed' }) },
        ],
        relations: [],
      },
      'update E1 title on candidate',
    );

    const diff = await diffBranches(db, mainId, candId);
    const updated = diff.entities.filter((d) => d.kind === 'updated');
    expect(diff.entities).toHaveLength(1);
    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe('E1');
    expect(updated[0].before?.title).toBe('Title');
    expect(updated[0].after?.title).toBe('Changed');
  });

  it('REVIEW FOCUS: change a relation TARGET on candidate ⇒ 1 updated relation', async () => {
    const mainId = await seedMain();
    const { branchId: candId } = await branchService.createCandidate(
      'cand',
      mainId,
    );

    // R1 originally E1->E2. Repoint target to E3 (same label/kind).
    await commits.commit(
      candId,
      {
        entities: [],
        relations: [
          {
            op: 'update',
            relation: makeRelation({
              relationId: 'R1',
              sourceEntityId: 'E1',
              targetEntityId: 'E3',
              label: 'contains',
            }),
          },
        ],
      },
      'repoint R1 target to E3',
    );

    const diff = await diffBranches(db, mainId, candId);
    const updated = diff.relations.filter((d) => d.kind === 'updated');
    expect(diff.relations).toHaveLength(1);
    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe('R1');
    expect(updated[0].before?.targetEntityId).toBe('E2');
    expect(updated[0].after?.targetEntityId).toBe('E3');
  });

  it('REVIEW FOCUS: change a relation SOURCE on candidate ⇒ 1 updated relation', async () => {
    const mainId = await seedMain();
    const { branchId: candId } = await branchService.createCandidate(
      'cand',
      mainId,
    );

    // R1 originally E1->E2. Repoint source to E3 (same label/kind/target).
    await commits.commit(
      candId,
      {
        entities: [],
        relations: [
          {
            op: 'update',
            relation: makeRelation({
              relationId: 'R1',
              sourceEntityId: 'E3',
              targetEntityId: 'E2',
              label: 'contains',
            }),
          },
        ],
      },
      'repoint R1 source to E3',
    );

    const diff = await diffBranches(db, mainId, candId);
    const updated = diff.relations.filter((d) => d.kind === 'updated');
    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe('R1');
    expect(updated[0].before?.sourceEntityId).toBe('E1');
    expect(updated[0].after?.sourceEntityId).toBe('E3');
  });

  it('change only a relation LABEL on candidate ⇒ 1 updated relation', async () => {
    const mainId = await seedMain();
    const { branchId: candId } = await branchService.createCandidate(
      'cand',
      mainId,
    );

    await commits.commit(
      candId,
      {
        entities: [],
        relations: [
          {
            op: 'update',
            relation: makeRelation({
              relationId: 'R1',
              sourceEntityId: 'E1',
              targetEntityId: 'E2',
              label: 'references',
            }),
          },
        ],
      },
      'relabel R1',
    );

    const diff = await diffBranches(db, mainId, candId);
    const updated = diff.relations.filter((d) => d.kind === 'updated');
    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe('R1');
    expect(updated[0].before?.label).toBe('contains');
    expect(updated[0].after?.label).toBe('references');
  });

  it('REVIEW FOCUS: reordered metadata.tags are NOT reported as updated', async () => {
    const mainId = await seedMain();
    const { branchId: candId } = await branchService.createCandidate(
      'cand',
      mainId,
    );

    // Re-commit E1 on main with ordered tags, then the SAME tags reversed on
    // the candidate. Tags are an order-irrelevant SET, so this is NOT a change.
    await commits.commit(
      mainId,
      {
        entities: [
          {
            op: 'update',
            entity: makeEntity({
              entityId: 'E1',
              metadata: {
                author: 'local',
                date: '2026-01-01',
                status: 'draft',
                tags: ['alpha', 'beta', 'gamma'],
              },
            }),
          },
        ],
        relations: [],
      },
      'set E1 tags on main',
    );
    await commits.commit(
      candId,
      {
        entities: [
          {
            op: 'update',
            entity: makeEntity({
              entityId: 'E1',
              metadata: {
                author: 'local',
                date: '2026-01-01',
                status: 'draft',
                tags: ['gamma', 'alpha', 'beta'],
              },
            }),
          },
        ],
        relations: [],
      },
      'reorder E1 tags on candidate',
    );

    const diff = await diffBranches(db, mainId, candId);
    expect(diff.entities.filter((d) => d.id === 'E1')).toEqual([]);
  });

  it('REVIEW FOCUS: reordered links are NOT reported as updated', async () => {
    const mainId = await seedMain();
    const { branchId: candId } = await branchService.createCandidate(
      'cand',
      mainId,
    );

    const linkA = {
      provider: 'github' as const,
      name: 'repo',
      url: 'https://example.com/a',
    };
    const linkB = {
      provider: 'confluence' as const,
      name: 'spec',
      url: 'https://example.com/b',
    };

    await commits.commit(
      mainId,
      {
        entities: [
          { op: 'update', entity: makeEntity({ entityId: 'E1', links: [linkA, linkB] }) },
        ],
        relations: [],
      },
      'set E1 links on main',
    );
    await commits.commit(
      candId,
      {
        entities: [
          { op: 'update', entity: makeEntity({ entityId: 'E1', links: [linkB, linkA] }) },
        ],
        relations: [],
      },
      'reorder E1 links on candidate',
    );

    const diff = await diffBranches(db, mainId, candId);
    expect(diff.entities.filter((d) => d.id === 'E1')).toEqual([]);
  });

  it('add + delete relations register independently', async () => {
    const mainId = await seedMain();
    const { branchId: candId } = await branchService.createCandidate(
      'cand',
      mainId,
    );

    await commits.commit(
      candId,
      {
        entities: [],
        relations: [
          { op: 'delete', relation: makeRelation({ relationId: 'R1' }) },
          {
            op: 'add',
            relation: makeRelation({
              relationId: 'R2',
              sourceEntityId: 'E2',
              targetEntityId: 'E3',
              label: 'depends',
            }),
          },
        ],
      },
      'swap relations',
    );

    const diff = await diffBranches(db, mainId, candId);
    const deleted = diff.relations.filter((d) => d.kind === 'deleted');
    const added = diff.relations.filter((d) => d.kind === 'added');
    expect(deleted.map((d) => d.id)).toEqual(['R1']);
    expect(added.map((d) => d.id)).toEqual(['R2']);
  });
});
