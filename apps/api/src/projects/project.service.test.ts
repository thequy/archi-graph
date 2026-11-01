// Tests for the Projects module: ProjectService CRUD + ensureProjectMain.
//
// A project is the top-level scope. Creating a project MUST give it its own
// `main` branch (via ensureProjectMain), tagged with that project's id. Two
// projects therefore get two DISTINCT main branches (distinct project_id).
//
// This suite also pins the CARRIED RULING from the Task 1 review: after the
// drop-default migration, the demo-project column DEFAULT on branches.project_id
// is gone, so a branch inserted WITHOUT project_id now fails loudly instead of
// silently scoping to the demo project. We prove explicit propagation two ways:
//   - ensureProjectMain(projectId) stamps the main branch with exactly projectId
//   - createCandidate off a project-B branch produces a branch with project_id=B
//
// Runs against a REAL Postgres+pgvector (podman, 5434). Serialized api suites.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { branches } from '../db/schema';
import {
  CommitService,
  ensureMainBranch,
  ensureProjectMain,
} from '../model/commit.service';
import { BranchService } from '../versioning/branch.service';
import { ProjectService } from './project.service';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5433/archigraph';

let db: Db;
let service: ProjectService;
let branchService: BranchService;
let commits: CommitService;

async function truncateAll(): Promise<void> {
  const { sql } = await import('drizzle-orm');
  await db.execute(
    sql`TRUNCATE TABLE
      embedding_jobs, doc_chunks,
      head_relations, head_entities,
      relation_versions, entity_versions,
      commits, branches, projects RESTART IDENTITY CASCADE`,
  );
  // This suite truncates `projects` (CASCADE also clears branches). The shared
  // podman DB is reused across ALL api suites sequentially; v1 suites rely on
  // the backfilled demo project existing so ensureMainBranch's FK holds. Re-seed
  // it here so wiping projects in THIS suite does not break a later suite.
  await db.execute(
    sql`INSERT INTO projects (id, name)
        VALUES ('11111111-1111-1111-1111-111111111111', 'CorpDigi')
        ON CONFLICT (id) DO NOTHING`,
  );
}

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  await runMigrations(DATABASE_URL);
  db = getDb(DATABASE_URL);
  service = new ProjectService(db);
  branchService = new BranchService(db);
  commits = new CommitService(db);
}, 60_000);

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
});

describe('ProjectService CRUD', () => {
  it('create ⇒ list includes it with its fields', async () => {
    const created = await service.create('Alpha', 'first project');
    expect(typeof created.id).toBe('string');
    expect(created.name).toBe('Alpha');
    expect(created.description).toBe('first project');

    const list = await service.list();
    expect(list.map((p) => p.name)).toContain('Alpha');
    const found = list.find((p) => p.id === created.id);
    expect(found?.description).toBe('first project');
  });

  it('create without description ⇒ null description', async () => {
    const created = await service.create('Beta');
    expect(created.description).toBeNull();
  });

  it('get returns the project; get(unknown) ⇒ null', async () => {
    const created = await service.create('Gamma');
    const got = await service.get(created.id);
    expect(got?.name).toBe('Gamma');
    const missing = await service.get('00000000-0000-0000-0000-000000000000');
    expect(missing).toBeNull();
  });

  it('rename changes the name and returns the updated row', async () => {
    const created = await service.create('Delta');
    const renamed = await service.rename(created.id, 'Delta-2');
    expect(renamed?.name).toBe('Delta-2');
    const got = await service.get(created.id);
    expect(got?.name).toBe('Delta-2');
  });

  it('remove deletes the project and cascades its branches', async () => {
    const created = await service.create('Epsilon');
    // sanity: it has a main branch
    const beforeBranches = await db
      .select()
      .from(branches)
      .where(eq(branches.projectId, created.id));
    expect(beforeBranches.length).toBe(1);

    await service.remove(created.id);

    const got = await service.get(created.id);
    expect(got).toBeNull();
    const afterBranches = await db
      .select()
      .from(branches)
      .where(eq(branches.projectId, created.id));
    expect(afterBranches.length).toBe(0);
  });
});

describe('ensureProjectMain', () => {
  it('create project ⇒ it has its own main branch tagged with projectId', async () => {
    const created = await service.create('Alpha');
    const mainId = await ensureProjectMain(db, created.id);

    const [row] = await db
      .select()
      .from(branches)
      .where(eq(branches.id, mainId));
    expect(row.name).toBe('main');
    expect(row.projectId).toBe(created.id);
    // empty initial commit established a head
    expect(row.headCommitId).not.toBeNull();
  });

  it('is idempotent per project: calling twice returns the same branchId', async () => {
    const created = await service.create('Alpha');
    const first = await ensureProjectMain(db, created.id);
    const second = await ensureProjectMain(db, created.id);
    expect(second).toBe(first);

    // exactly one main branch for that project
    const mains = await db
      .select()
      .from(branches)
      .where(eq(branches.projectId, created.id));
    expect(mains.filter((b) => b.name === 'main').length).toBe(1);
  });

  it('two projects ⇒ two distinct main branches (distinct project_id)', async () => {
    const a = await service.create('Alpha');
    const b = await service.create('Beta');
    const mainA = await ensureProjectMain(db, a.id);
    const mainB = await ensureProjectMain(db, b.id);

    expect(mainA).not.toBe(mainB);

    const [rowA] = await db.select().from(branches).where(eq(branches.id, mainA));
    const [rowB] = await db.select().from(branches).where(eq(branches.id, mainB));
    expect(rowA.projectId).toBe(a.id);
    expect(rowB.projectId).toBe(b.id);
    expect(rowA.projectId).not.toBe(rowB.projectId);
  });

  it('ensureMainBranch wrapper still works (demo project main)', async () => {
    // truncateAll() re-seeds the demo project row the wrapper scopes to (in
    // real v1 paths it exists from the backfill migration).
    const mainId = await ensureMainBranch(db);
    const [row] = await db.select().from(branches).where(eq(branches.id, mainId));
    expect(row.name).toBe('main');
    // wrapper scopes to the demo project explicitly.
    expect(row.projectId).toBe('11111111-1111-1111-1111-111111111111');
  });
});

describe('CARRIED RULING: explicit project_id propagation', () => {
  it('createCandidate off a project-B branch inherits project_id = B (not demo)', async () => {
    const b = await service.create('Beta');
    const mainB = await ensureProjectMain(db, b.id);

    const { branchId: candId } = await branchService.createCandidate(
      'cand-b',
      mainB,
    );
    const [cand] = await db
      .select()
      .from(branches)
      .where(eq(branches.id, candId));
    expect(cand.projectId).toBe(b.id);
    expect(cand.projectId).not.toBe('11111111-1111-1111-1111-111111111111');
  });

  it('inserting a branch WITHOUT project_id fails (column default dropped)', async () => {
    const { sql } = await import('drizzle-orm');
    await expect(
      db.execute(sql`INSERT INTO branches (name, author) VALUES ('nope', 'local')`),
    ).rejects.toThrow();
  });
});
