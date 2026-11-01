// Review Focus for Task 5: `diagrams` must be a FIRST-CLASS VERSIONED field.
//
// The failure mode this test exists to catch: adding the shared type + the
// column but forgetting to thread it through commit → entity_versions →
// head_entities → foldHeadState (and entityEquals). If any mapper site is
// missed, the diagrams array silently vanishes after a commit, or a diagram
// change is NOT seen as `updated`. We assert the full round-trip end-to-end.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DiagramSpec, Entity } from '@archi-graph/shared';
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

const DIAGRAM: DiagramSpec = {
  id: 'd1',
  kind: 'sequence',
  title: 'Login',
  mermaid: 'sequenceDiagram\n A->>B: hi',
};

describe('Entity.diagrams versioned round-trip', () => {
  it('commit with diagrams ⇒ foldHeadState returns the diagrams array intact', async () => {
    const branchId = await ensureMainBranch(db);
    const e = makeEntity({ entityId: 'E1', diagrams: [DIAGRAM] });

    await service.commit(
      branchId,
      { entities: [{ op: 'add', entity: e }], relations: [] },
      'add E1 with a diagram',
    );

    const head = await foldHeadState(db, branchId);
    const folded = head.entities.find((x) => x.entityId === 'E1');
    expect(folded).toBeDefined();
    // The diagrams array must survive the commit/fold round-trip, not be lost.
    expect(folded?.diagrams).toEqual([DIAGRAM]);
  });

  it('commit an update changing the mermaid text ⇒ diffBranches reports the entity as updated', async () => {
    const baseBranch = await ensureMainBranch(db);
    const e = makeEntity({ entityId: 'E1', diagrams: [DIAGRAM] });
    await service.commit(
      baseBranch,
      { entities: [{ op: 'add', entity: e }], relations: [] },
      'add E1',
    );

    // Fork a candidate so we have two branches to diff.
    const { BranchService } = await import('../versioning/branch.service');
    const branchService = new BranchService(db);
    const { branchId: candidate } = await branchService.createCandidate(
      'cand',
      baseBranch,
    );

    // Change ONLY the mermaid text on the candidate.
    const changed = makeEntity({
      entityId: 'E1',
      diagrams: [{ ...DIAGRAM, mermaid: 'sequenceDiagram\n A->>B: bye' }],
    });
    await service.commit(
      candidate,
      { entities: [{ op: 'update', entity: changed }], relations: [] },
      'change diagram mermaid',
    );

    const diff = await diffBranches(db, baseBranch, candidate);
    const item = diff.entities.find((d) => d.id === 'E1');
    expect(item).toBeDefined();
    expect(item?.kind).toBe('updated');
  });

  it('byte-identical diagrams ⇒ entityEquals true (not spuriously updated)', () => {
    const a = makeEntity({ entityId: 'E1', diagrams: [DIAGRAM] });
    const b = makeEntity({
      entityId: 'E1',
      diagrams: [{ id: 'd1', kind: 'sequence', title: 'Login', mermaid: 'sequenceDiagram\n A->>B: hi' }],
    });
    expect(entityEquals(a, b)).toBe(true);
  });

  it('differing mermaid text ⇒ entityEquals false', () => {
    const a = makeEntity({ entityId: 'E1', diagrams: [DIAGRAM] });
    const b = makeEntity({
      entityId: 'E1',
      diagrams: [{ ...DIAGRAM, mermaid: 'sequenceDiagram\n A->>B: bye' }],
    });
    expect(entityEquals(a, b)).toBe(false);
  });
});
