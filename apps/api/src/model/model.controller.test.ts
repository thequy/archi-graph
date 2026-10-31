// e2e tests for the model CRUD controller.
//
// Runs against a REAL Postgres+pgvector (podman) via the NestJS testing module.
// The suite boots the ModelModule, applies migrations, ensures a `main` branch,
// and truncates all tables between tests for determinism. (api suites are
// serialized via vitest.config fileParallelism:false — see Task 3.)

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
import {
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import request from 'supertest';
import type { Entity, HeadState, Relation } from '@archi-graph/shared';
import { getDb, closeDb, type Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { ensureMainBranch } from './commit.service';
import { ModelModule } from './model.module';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5433/archigraph';

let app: INestApplication;
let db: Db;
let branchId: string;

function entityBody(overrides: Partial<Entity> = {}): Record<string, unknown> {
  return {
    type: 'brd',
    code: 'C1',
    shortTitle: 'short',
    group: 'soe',
    tier: 't0',
    title: 'Title',
    metadata: {
      author: 'local',
      date: '2026-01-01',
      status: 'draft',
      tags: [],
    },
    contentMarkdown: '# content',
    flow: null,
    links: [],
    ...overrides,
  };
}

function relationBody(
  overrides: Partial<Relation> = {},
): Record<string, unknown> {
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

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  await runMigrations(DATABASE_URL);
  db = getDb(DATABASE_URL);

  const moduleRef = await Test.createTestingModule({
    imports: [ModelModule],
  }).compile();

  app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );
  await app.init();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
  branchId = await ensureMainBranch(db);
});

describe('ModelController (e2e)', () => {
  it('POST entity then GET graph returns it; DELETE then GET omits it', async () => {
    const server = app.getHttpServer();

    const post = await request(server)
      .post(`/branches/${branchId}/entities`)
      .send(entityBody({ entityId: 'E1', code: 'BRD-1' }))
      .expect(201);

    expect(post.body.commitId).toBeTruthy();
    expect(post.body.entityId).toBe('E1');

    const graph1 = await request(server)
      .get(`/branches/${branchId}/graph`)
      .expect(200);
    const head1 = graph1.body as HeadState;
    expect(head1.entities.map((e) => e.entityId)).toEqual(['E1']);
    expect(head1.entities[0]).toMatchObject({ code: 'BRD-1', type: 'brd' });

    await request(server)
      .delete(`/branches/${branchId}/entities/E1`)
      .expect(200);

    const graph2 = await request(server)
      .get(`/branches/${branchId}/graph`)
      .expect(200);
    const head2 = graph2.body as HeadState;
    expect(head2.entities.map((e) => e.entityId)).toEqual([]);
  });

  it('server fills entityId when absent', async () => {
    const server = app.getHttpServer();
    const post = await request(server)
      .post(`/branches/${branchId}/entities`)
      .send(entityBody())
      .expect(201);
    expect(typeof post.body.entityId).toBe('string');
    expect(post.body.entityId.length).toBeGreaterThan(0);

    const graph = await request(server)
      .get(`/branches/${branchId}/graph`)
      .expect(200);
    const head = graph.body as HeadState;
    expect(head.entities.map((e) => e.entityId)).toEqual([post.body.entityId]);
  });

  it('POST relation then GET graph returns it; DELETE then GET omits it', async () => {
    const server = app.getHttpServer();

    // Source + target entities must exist first.
    await request(server)
      .post(`/branches/${branchId}/entities`)
      .send(entityBody({ entityId: 'E1' }))
      .expect(201);
    await request(server)
      .post(`/branches/${branchId}/entities`)
      .send(entityBody({ entityId: 'E2', type: 'sad' }))
      .expect(201);

    const post = await request(server)
      .post(`/branches/${branchId}/relations`)
      .send(relationBody({ relationId: 'R1' }))
      .expect(201);
    expect(post.body.commitId).toBeTruthy();
    expect(post.body.relationId).toBe('R1');

    const graph1 = await request(server)
      .get(`/branches/${branchId}/graph`)
      .expect(200);
    const head1 = graph1.body as HeadState;
    expect(head1.relations.map((r) => r.relationId)).toEqual(['R1']);
    expect(head1.relations[0]).toMatchObject({
      sourceEntityId: 'E1',
      targetEntityId: 'E2',
      kind: 'hierarchy',
    });

    await request(server)
      .delete(`/branches/${branchId}/relations/R1`)
      .expect(200);

    const graph2 = await request(server)
      .get(`/branches/${branchId}/graph`)
      .expect(200);
    const head2 = graph2.body as HeadState;
    expect(head2.relations.map((r) => r.relationId)).toEqual([]);
  });

  it('POST relation with absent source/target ⇒ 400 (no dangling relation)', async () => {
    const server = app.getHttpServer();

    // Only E1 exists; target E2 is absent.
    await request(server)
      .post(`/branches/${branchId}/entities`)
      .send(entityBody({ entityId: 'E1' }))
      .expect(201);

    await request(server)
      .post(`/branches/${branchId}/relations`)
      .send(
        relationBody({
          relationId: 'R1',
          sourceEntityId: 'E1',
          targetEntityId: 'E2',
        }),
      )
      .expect(400);

    // Both absent likewise.
    await request(server)
      .post(`/branches/${branchId}/relations`)
      .send(
        relationBody({
          relationId: 'R2',
          sourceEntityId: 'X',
          targetEntityId: 'Y',
        }),
      )
      .expect(400);

    const graph = await request(server)
      .get(`/branches/${branchId}/graph`)
      .expect(200);
    const head = graph.body as HeadState;
    expect(head.relations).toHaveLength(0);
  });

  it('rejects invalid enum values (class-validator) ⇒ 400', async () => {
    const server = app.getHttpServer();
    await request(server)
      .post(`/branches/${branchId}/entities`)
      .send(entityBody({ entityId: 'E1', type: 'bogus' as Entity['type'] }))
      .expect(400);
  });

  it('write to a non-existent branch fails cleanly (not 500)', async () => {
    const server = app.getHttpServer();
    const missing = '00000000-0000-0000-0000-000000000000';
    const res = await request(server)
      .post(`/branches/${missing}/entities`)
      .send(entityBody({ entityId: 'E1' }));
    expect([400, 404]).toContain(res.status);
  });

  it('accepts optional ?message=', async () => {
    const server = app.getHttpServer();
    await request(server)
      .post(`/branches/${branchId}/entities?message=custom%20msg`)
      .send(entityBody({ entityId: 'E1' }))
      .expect(201);

    const { sql } = await import('drizzle-orm');
    const rows = await db.execute<{ message: string }>(
      sql`SELECT message FROM commits ORDER BY created_at DESC LIMIT 1`,
    );
    expect(rows.rows[0]?.message).toBe('custom msg');
  });
});
