// BRANCH PROJECT SCOPING (Review Focus).
//
// BranchService.listBranches(projectId) must return ONLY the branches of that
// project — a project's branch listing must never leak another project's
// branches. Two projects each get their own `main` (via ensureProjectMain) plus
// any candidates forked within them; listBranches(projectIdA) returns A's set
// and nothing from B.
//
// The no-arg form listBranches() remains all-branches (backward compatible with
// the v1 GET /branches behavior); the project-scoped overload is the new,
// isolated listing the controller uses when a ?projectId= is supplied.
//
// Runs against a REAL Postgres+pgvector (podman, 5434). Serialized api suites.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb, closeDb, type Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { CommitService, ensureProjectMain } from '../model/commit.service';
import { ProjectService } from '../projects/project.service';
import { BranchService } from './branch.service';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5433/archigraph';

let db: Db;
let commits: CommitService;
let projectService: ProjectService;
let service: BranchService;

async function truncateAll(): Promise<void> {
  const { sql } = await import('drizzle-orm');
  await db.execute(
    sql`TRUNCATE TABLE
      embedding_jobs, doc_chunks,
      head_relations, head_entities,
      relation_versions, entity_versions,
      commits, branches, projects RESTART IDENTITY CASCADE`,
  );
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
  commits = new CommitService(db);
  projectService = new ProjectService(db);
  service = new BranchService(db);
}, 60_000);

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
});

describe('BranchService.listBranches(projectId) — project scoping', () => {
  it('returns only the given project branches, never another project branches', async () => {
    const projA = await projectService.create('Project A');
    const projB = await projectService.create('Project B');
    const mainA = await ensureProjectMain(db, projA.id);

    // A fork inside project A; and a fork inside project B.
    await service.createCandidate('cand-a', mainA);
    const mainB = await ensureProjectMain(db, projB.id);
    await service.createCandidate('cand-b', mainB);

    const listA = await service.listBranches(projA.id);
    const namesA = listA.map((b) => b.name).sort();
    expect(namesA).toEqual(['cand-a', 'main']);

    const listB = await service.listBranches(projB.id);
    const namesB = listB.map((b) => b.name).sort();
    expect(namesB).toEqual(['cand-b', 'main']);

    // Hard isolation: nothing from B appears in A's listing.
    expect(listA.some((b) => b.name === 'cand-b')).toBe(false);
  });

  it('no-arg listBranches() still returns all branches (backward compatible)', async () => {
    const projA = await projectService.create('Project A');
    const projB = await projectService.create('Project B');
    await ensureProjectMain(db, projA.id);
    await ensureProjectMain(db, projB.id);

    const all = await service.listBranches();
    // Two project mains (projects.create already made each) — at least 2.
    expect(all.length).toBeGreaterThanOrEqual(2);
  });
});
