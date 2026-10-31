// Tests for blast-radius analysis — recursive CTE over per-branch head-state.
//
// Runs against a REAL Postgres+pgvector (podman) via DATABASE_URL. beforeAll
// applies migrations + ensures `main`; tables are truncated between tests.
// (api suites are serialized via vitest.config fileParallelism:false.)
//
// DIRECTION SEMANTICS (documented, must stay consistent with blast.service.ts):
//   Relations are stored source -> target meaning "source calls/uses target"
//   (e.g. frontend -> gateway -> bff -> backend -> core). "Blast radius" = what a
//   change/failure in node N can REACH / affect.
//   - DOWNSTREAM (impact of a change to N): the DEPENDENTS of N — the callers
//     that would be affected if N changes. We walk edges BACKWARD: from a node
//     `current`, follow relations whose TARGET = current and yield the SOURCE.
//     So for chain A->B->C (A calls B calls C), downstream of C = {B, A}:
//     B calls C, A calls B, both affected by a change to C.
//   - UPSTREAM (dependencies of N): the things N itself calls/uses. We walk
//     edges FORWARD: from `current`, follow relations whose SOURCE = current and
//     yield the TARGET. For A->B->C, upstream of A = {B, C}.
//
// Review Focus (Global Constraint): a CYCLE must terminate and return each node
// exactly once (visited-set inside the CTE).

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import type { Entity, Relation } from '@archi-graph/shared';
import { getDb, closeDb, type Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { CommitService, ensureMainBranch } from '../model/commit.service';
import { BranchService } from '../versioning/branch.service';
import {
  blastRadiusForNode,
  blastRadiusForCandidate,
} from './blast.service';

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
    label: 'calls',
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

/** Index a BlastRadius by entityId for easy assertions. */
function byId(
  nodes: { entityId: string; distance: number; via: string; cause: string[] }[],
) {
  return new Map(nodes.map((n) => [n.entityId, n]));
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

describe('blastRadiusForNode', () => {
  it('chain A->B->C: downstream of A = {} ; downstream of C = {B d1, A d2}', async () => {
    // A calls B calls C. A->B, B->C.
    const branchId = await ensureMainBranch(db);
    await commits.commit(
      branchId,
      {
        entities: [
          { op: 'add', entity: makeEntity({ entityId: 'A' }) },
          { op: 'add', entity: makeEntity({ entityId: 'B' }) },
          { op: 'add', entity: makeEntity({ entityId: 'C' }) },
        ],
        relations: [
          {
            op: 'add',
            relation: makeRelation({
              relationId: 'AB',
              sourceEntityId: 'A',
              targetEntityId: 'B',
            }),
          },
          {
            op: 'add',
            relation: makeRelation({
              relationId: 'BC',
              sourceEntityId: 'B',
              targetEntityId: 'C',
            }),
          },
        ],
      },
      'seed chain',
    );

    // Downstream = dependents (callers). A has no callers.
    const downA = await blastRadiusForNode(db, branchId, 'A', 'downstream');
    expect(downA.direction).toBe('downstream');
    expect(downA.nodes).toEqual([]);

    // Downstream of C = {B at dist1, A at dist2}.
    const downC = await blastRadiusForNode(db, branchId, 'C', 'downstream');
    const dc = byId(downC.nodes);
    expect([...dc.keys()].sort()).toEqual(['A', 'B']);
    expect(dc.get('B')!.distance).toBe(1);
    expect(dc.get('A')!.distance).toBe(2);
  });

  it('chain A->B->C: upstream of A = {B d1, C d2}; upstream of C = {}', async () => {
    const branchId = await ensureMainBranch(db);
    await commits.commit(
      branchId,
      {
        entities: [
          { op: 'add', entity: makeEntity({ entityId: 'A' }) },
          { op: 'add', entity: makeEntity({ entityId: 'B' }) },
          { op: 'add', entity: makeEntity({ entityId: 'C' }) },
        ],
        relations: [
          {
            op: 'add',
            relation: makeRelation({
              relationId: 'AB',
              sourceEntityId: 'A',
              targetEntityId: 'B',
            }),
          },
          {
            op: 'add',
            relation: makeRelation({
              relationId: 'BC',
              sourceEntityId: 'B',
              targetEntityId: 'C',
            }),
          },
        ],
      },
      'seed chain',
    );

    // Upstream = dependencies (things N calls). A calls B calls C.
    const upA = await blastRadiusForNode(db, branchId, 'A', 'upstream');
    expect(upA.direction).toBe('upstream');
    const ua = byId(upA.nodes);
    expect([...ua.keys()].sort()).toEqual(['B', 'C']);
    expect(ua.get('B')!.distance).toBe(1);
    expect(ua.get('C')!.distance).toBe(2);

    // C calls nothing.
    const upC = await blastRadiusForNode(db, branchId, 'C', 'upstream');
    expect(upC.nodes).toEqual([]);
  });

  it('single-node blast marks every node via:baseline and cause:[root]', async () => {
    const branchId = await ensureMainBranch(db);
    await commits.commit(
      branchId,
      {
        entities: [
          { op: 'add', entity: makeEntity({ entityId: 'A' }) },
          { op: 'add', entity: makeEntity({ entityId: 'B' }) },
        ],
        relations: [
          {
            op: 'add',
            relation: makeRelation({
              relationId: 'AB',
              sourceEntityId: 'A',
              targetEntityId: 'B',
            }),
          },
        ],
      },
      'seed',
    );

    const up = await blastRadiusForNode(db, branchId, 'A', 'upstream');
    const b = byId(up.nodes).get('B')!;
    expect(b.via).toBe('baseline');
    expect(b.cause).toEqual(['A']);
  });

  it('REVIEW FOCUS: cycle A->B->A terminates and returns each node once', async () => {
    const branchId = await ensureMainBranch(db);
    await commits.commit(
      branchId,
      {
        entities: [
          { op: 'add', entity: makeEntity({ entityId: 'A' }) },
          { op: 'add', entity: makeEntity({ entityId: 'B' }) },
        ],
        relations: [
          {
            op: 'add',
            relation: makeRelation({
              relationId: 'AB',
              sourceEntityId: 'A',
              targetEntityId: 'B',
            }),
          },
          {
            op: 'add',
            relation: makeRelation({
              relationId: 'BA',
              sourceEntityId: 'B',
              targetEntityId: 'A',
            }),
          },
        ],
      },
      'seed cycle',
    );

    // Upstream of A in cycle A->B->A: A calls B (d1), B calls A (d2 back to
    // root). Root is never re-emitted; B appears once. Must terminate.
    const up = await blastRadiusForNode(db, branchId, 'A', 'upstream');
    const ids = up.nodes.map((n) => n.entityId).sort();
    // Each reachable non-root node exactly once.
    expect(ids).toEqual(['B']);
    expect(up.nodes.filter((n) => n.entityId === 'B')).toHaveLength(1);

    // Downstream direction on the same cycle also terminates.
    const down = await blastRadiusForNode(db, branchId, 'A', 'downstream');
    expect(down.nodes.map((n) => n.entityId).sort()).toEqual(['B']);
  });

  it('maxDepth caps the recursion', async () => {
    const branchId = await ensureMainBranch(db);
    await commits.commit(
      branchId,
      {
        entities: [
          { op: 'add', entity: makeEntity({ entityId: 'A' }) },
          { op: 'add', entity: makeEntity({ entityId: 'B' }) },
          { op: 'add', entity: makeEntity({ entityId: 'C' }) },
        ],
        relations: [
          {
            op: 'add',
            relation: makeRelation({
              relationId: 'AB',
              sourceEntityId: 'A',
              targetEntityId: 'B',
            }),
          },
          {
            op: 'add',
            relation: makeRelation({
              relationId: 'BC',
              sourceEntityId: 'B',
              targetEntityId: 'C',
            }),
          },
        ],
      },
      'seed chain',
    );

    const up = await blastRadiusForNode(db, branchId, 'A', 'upstream', 1);
    expect(up.nodes.map((n) => n.entityId)).toEqual(['B']);
  });
});

describe('blastRadiusForCandidate', () => {
  it('delete source traverses BASELINE; add source traverses CANDIDATE; via set', async () => {
    // Baseline (main): A->B->C exists. On candidate we DELETE B (present in
    // baseline) and ADD a fresh node N with edge N->C (candidate-only).
    const mainId = await ensureMainBranch(db);
    await commits.commit(
      mainId,
      {
        entities: [
          { op: 'add', entity: makeEntity({ entityId: 'A' }) },
          { op: 'add', entity: makeEntity({ entityId: 'B' }) },
          { op: 'add', entity: makeEntity({ entityId: 'C' }) },
        ],
        relations: [
          {
            op: 'add',
            relation: makeRelation({
              relationId: 'AB',
              sourceEntityId: 'A',
              targetEntityId: 'B',
            }),
          },
          {
            op: 'add',
            relation: makeRelation({
              relationId: 'BC',
              sourceEntityId: 'B',
              targetEntityId: 'C',
            }),
          },
        ],
      },
      'seed baseline chain',
    );

    const { branchId: candId } = await branchService.createCandidate(
      'cand',
      mainId,
    );

    // On candidate: delete B (a DELETE source -> traversed on BASELINE) and add
    // N with N->C (an ADD source -> traversed on CANDIDATE).
    await commits.commit(
      candId,
      {
        entities: [
          { op: 'delete', entity: makeEntity({ entityId: 'B' }) },
          { op: 'add', entity: makeEntity({ entityId: 'N' }) },
        ],
        relations: [
          { op: 'delete', relation: makeRelation({ relationId: 'AB' }) },
          { op: 'delete', relation: makeRelation({ relationId: 'BC' }) },
          {
            op: 'add',
            relation: makeRelation({
              relationId: 'NC',
              sourceEntityId: 'N',
              targetEntityId: 'C',
            }),
          },
        ],
      },
      'cand: delete B, add N->C',
    );

    // Downstream impact of the change-set: who is affected.
    const blast = await blastRadiusForCandidate(
      db,
      mainId,
      candId,
      'downstream',
    );
    expect(blast.direction).toBe('downstream');
    const m = byId(blast.nodes);

    // Deleting B (baseline traversal): downstream dependents of B in baseline =
    // {A} (A calls B). via must be 'baseline', cause includes 'B'.
    expect(m.has('A')).toBe(true);
    expect(m.get('A')!.via).toBe('baseline');
    expect(m.get('A')!.cause).toContain('B');

    // Adding N->C (candidate traversal): downstream dependents of N in the
    // CANDIDATE graph. N has no callers, so N itself yields nothing downstream;
    // but C is a dependent reachable from N? No: downstream of N = callers of N
    // = {}. To make the candidate-graph traversal observable, assert the via of
    // any node reached from the ADD source N is 'candidate'. Here the ADD set
    // contributes no downstream nodes, so instead verify NO baseline-only node
    // (B's old targets) leaked via candidate. The key candidate-graph assertion
    // is covered by the upstream variant below.
    // (kept minimal: just ensure deletion-side baseline result is present.)

    // Upstream variant makes the candidate traversal observable: upstream of N
    // (dependencies N calls) in the CANDIDATE graph = {C}.
    const up = await blastRadiusForCandidate(db, mainId, candId, 'upstream');
    const um = byId(up.nodes);
    expect(um.has('C')).toBe(true);
    expect(um.get('C')!.via).toBe('candidate');
    expect(um.get('C')!.cause).toContain('N');
  });
});
