// e2e tests for the versioning controller (candidate branches + diff).
//
// Boots the whole AppModule (ModelModule + VersioningModule) against a REAL
// Postgres+pgvector (podman) via the NestJS testing module. Serialized api
// suites (vitest.config fileParallelism:false). Tables truncated between tests.

import 'reflect-metadata';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Entity, GraphDiff } from '@archi-graph/shared';
import { getDb, closeDb, type Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { CommitService, ensureMainBranch } from '../model/commit.service';
import { AppModule } from '../app.module';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5433/archigraph';

let app: INestApplication;
let db: Db;
let commits: CommitService;

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
  process.env.DATABASE_URL = DATABASE_URL;
  await runMigrations(DATABASE_URL);
  db = getDb(DATABASE_URL);
  commits = new CommitService(db);

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
});

describe('VersioningController (e2e)', () => {
  it('POST /branches creates a candidate; GET /branches lists it', async () => {
    const server = app.getHttpServer();
    const mainId = await ensureMainBranch(db);
    await commits.commit(
      mainId,
      {
        entities: [{ op: 'add', entity: makeEntity({ entityId: 'E1' }) }],
        relations: [],
      },
      'seed',
    );

    const post = await request(server)
      .post('/branches')
      .send({ name: 'cand', fromBranchId: mainId })
      .expect(201);
    expect(typeof post.body.branchId).toBe('string');
    expect(post.body.branchId.length).toBeGreaterThan(0);

    const list = await request(server).get('/branches').expect(200);
    const names = (list.body as { name: string }[]).map((b) => b.name).sort();
    expect(names).toEqual(['cand', 'main']);
  });

  it('POST /branches with unknown fromBranchId ⇒ 404', async () => {
    const server = app.getHttpServer();
    await ensureMainBranch(db);
    const res = await request(server)
      .post('/branches')
      .send({ name: 'cand', fromBranchId: '00000000-0000-0000-0000-000000000000' })
      .expect(404);
    expect(String(res.body.message)).toMatch(/branch not found/i);
  });

  it('GET /diff returns a GraphDiff of added entity on candidate', async () => {
    const server = app.getHttpServer();
    const mainId = await ensureMainBranch(db);
    await commits.commit(
      mainId,
      {
        entities: [{ op: 'add', entity: makeEntity({ entityId: 'E1' }) }],
        relations: [],
      },
      'seed',
    );

    const post = await request(server)
      .post('/branches')
      .send({ name: 'cand', fromBranchId: mainId })
      .expect(201);
    const candId = post.body.branchId as string;

    await commits.commit(
      candId,
      {
        entities: [{ op: 'add', entity: makeEntity({ entityId: 'E2', code: 'NEW' }) }],
        relations: [],
      },
      'add E2',
    );

    const res = await request(server)
      .get('/diff')
      .query({ base: mainId, candidate: candId })
      .expect(200);
    const diff = res.body as GraphDiff;
    expect(diff.entities).toHaveLength(1);
    expect(diff.entities[0].kind).toBe('added');
    expect(diff.entities[0].id).toBe('E2');
  });

  it('GET /diff missing query param ⇒ 400', async () => {
    const server = app.getHttpServer();
    const mainId = await ensureMainBranch(db);
    await request(server).get('/diff').query({ base: mainId }).expect(400);
  });

  it('POST /branches/:candidateId/merge of disjoint changes ⇒ clean', async () => {
    const server = app.getHttpServer();
    const mainId = await ensureMainBranch(db);
    await commits.commit(
      mainId,
      {
        entities: [{ op: 'add', entity: makeEntity({ entityId: 'E1' }) }],
        relations: [],
      },
      'seed',
    );

    const post = await request(server)
      .post('/branches')
      .send({ name: 'cand', fromBranchId: mainId })
      .expect(201);
    const candId = post.body.branchId as string;

    await commits.commit(
      candId,
      {
        entities: [{ op: 'add', entity: makeEntity({ entityId: 'E2', code: 'NEW' }) }],
        relations: [],
      },
      'cand adds E2',
    );

    const res = await request(server)
      .post(`/branches/${candId}/merge`)
      .send({})
      .expect(201);
    expect(res.body.status).toBe('clean');
    expect(typeof res.body.commitId).toBe('string');
  });

  it('POST /branches/:candidateId/merge surfaces a conflict payload', async () => {
    const server = app.getHttpServer();
    const mainId = await ensureMainBranch(db);
    await commits.commit(
      mainId,
      {
        entities: [{ op: 'add', entity: makeEntity({ entityId: 'E1' }) }],
        relations: [],
      },
      'seed',
    );
    const post = await request(server)
      .post('/branches')
      .send({ name: 'cand', fromBranchId: mainId })
      .expect(201);
    const candId = post.body.branchId as string;

    await commits.commit(
      mainId,
      {
        entities: [{ op: 'update', entity: makeEntity({ entityId: 'E1', title: 'M' }) }],
        relations: [],
      },
      'main edits E1',
    );
    await commits.commit(
      candId,
      {
        entities: [{ op: 'update', entity: makeEntity({ entityId: 'E1', title: 'C' }) }],
        relations: [],
      },
      'cand edits E1',
    );

    const res = await request(server)
      .post(`/branches/${candId}/merge`)
      .send({})
      .expect(201);
    expect(res.body.status).toBe('conflict');
    expect(res.body.conflicts).toHaveLength(1);
    expect(res.body.conflicts[0].id).toBe('E1');
  });
});
