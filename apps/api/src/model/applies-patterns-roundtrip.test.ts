// Review Focus for Task 10: `appliesPatterns` must be a FIRST-CLASS VERSIONED
// field — the set of pattern slugs a component "applies" (Slice D, Pattern Wiki).
//
// Mirrors the Task 5 `diagrams` round-trip, with ONE deliberate difference:
// appliesPatterns is a SET (order-insensitive, like metadata.tags), NOT a
// positional array. A mere REORDER must NOT register as `updated`; adding or
// removing a slug MUST.
//
// The failure mode this test exists to catch: adding the shared type + the
// column but forgetting to thread it through commit → entity_versions →
// head_entities → foldHeadState (and entityEquals). If any mapper site is
// missed, the array silently vanishes after a commit. We assert the full
// round-trip end-to-end.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Entity } from '@archi-graph/shared';
import { getDb, closeDb, type Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { entityEquals } from '../versioning/equality';
import { diffBranches } from '../versioning/diff';
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

describe('Entity.appliesPatterns versioned round-trip (SET semantics)', () => {
  it('commit with appliesPatterns ⇒ foldHeadState returns the array intact', async () => {
    const branchId = await ensureMainBranch(db);
    const e = makeEntity({ entityId: 'E1', appliesPatterns: ['singleton', 'cqrs'] });

    await service.commit(
      branchId,
      { entities: [{ op: 'add', entity: e }], relations: [] },
      'add E1 applying singleton + cqrs',
    );

    const head = await foldHeadState(db, branchId);
    const folded = head.entities.find((x) => x.entityId === 'E1');
    expect(folded).toBeDefined();
    // The array must survive the commit/fold round-trip, not be lost.
    expect(folded?.appliesPatterns).toEqual(['singleton', 'cqrs']);
  });

  it('reorder of the same slugs ⇒ entityEquals true AND diff NOT updated (SET)', async () => {
    // entityEquals: a pure reorder is the SAME set.
    const a = makeEntity({ entityId: 'E1', appliesPatterns: ['singleton', 'cqrs'] });
    const b = makeEntity({ entityId: 'E1', appliesPatterns: ['cqrs', 'singleton'] });
    expect(entityEquals(a, b)).toBe(true);

    // And end-to-end through diff: committing a reorder must NOT report updated.
    const baseBranch = await ensureMainBranch(db);
    await service.commit(
      baseBranch,
      { entities: [{ op: 'add', entity: a }], relations: [] },
      'add E1',
    );

    const { BranchService } = await import('../versioning/branch.service');
    const branchService = new BranchService(db);
    const { branchId: candidate } = await branchService.createCandidate(
      'cand-reorder',
      baseBranch,
    );

    await service.commit(
      candidate,
      { entities: [{ op: 'update', entity: b }], relations: [] },
      'reorder appliesPatterns',
    );

    const diff = await diffBranches(db, baseBranch, candidate);
    const item = diff.entities.find((d) => d.id === 'E1');
    // A reorder of a set is not a change ⇒ it should not appear as updated.
    expect(item).toBeUndefined();
  });

  it('adding a new pattern slug ⇒ entityEquals false AND diff reports updated', async () => {
    const a = makeEntity({ entityId: 'E1', appliesPatterns: ['singleton', 'cqrs'] });
    const withSaga = makeEntity({
      entityId: 'E1',
      appliesPatterns: ['singleton', 'cqrs', 'saga'],
    });
    expect(entityEquals(a, withSaga)).toBe(false);

    const baseBranch = await ensureMainBranch(db);
    await service.commit(
      baseBranch,
      { entities: [{ op: 'add', entity: a }], relations: [] },
      'add E1',
    );

    const { BranchService } = await import('../versioning/branch.service');
    const branchService = new BranchService(db);
    const { branchId: candidate } = await branchService.createCandidate(
      'cand-add',
      baseBranch,
    );

    await service.commit(
      candidate,
      { entities: [{ op: 'update', entity: withSaga }], relations: [] },
      'add saga pattern',
    );

    const diff = await diffBranches(db, baseBranch, candidate);
    const item = diff.entities.find((d) => d.id === 'E1');
    expect(item).toBeDefined();
    expect(item?.kind).toBe('updated');
  });
});
