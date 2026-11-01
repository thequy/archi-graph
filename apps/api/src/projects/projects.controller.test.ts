// e2e tests for the Projects HTTP surface.
//
//   POST   /projects      { name, description? } -> ProjectDto (201)
//   GET    /projects                             -> ProjectDto[]
//   GET    /projects/:id                         -> ProjectDto | 404
//   PATCH  /projects/:id   { name }              -> ProjectDto | 404
//   DELETE /projects/:id                         -> 200 | 404
//
// Boots the whole AppModule against a REAL Postgres+pgvector (podman, 5434) via
// the NestJS testing module. Serialized api suites. Tables truncated per test.

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
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { branches } from '../db/schema';
import { AppModule } from '../app.module';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5433/archigraph';

let app: INestApplication;
let db: Db;

async function truncateAll(): Promise<void> {
  const { sql } = await import('drizzle-orm');
  await db.execute(
    sql`TRUNCATE TABLE
      embedding_jobs, doc_chunks,
      head_relations, head_entities,
      relation_versions, entity_versions,
      commits, branches, projects RESTART IDENTITY CASCADE`,
  );
  // Re-seed the demo project after wiping `projects` so the shared podman DB
  // still satisfies v1 suites' ensureMainBranch FK (see project.service.test).
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

describe('ProjectsController (e2e)', () => {
  it('POST /projects creates a project AND its own main branch', async () => {
    const server = app.getHttpServer();
    const res = await request(server)
      .post('/projects')
      .send({ name: 'Alpha', description: 'first' })
      .expect(201);
    expect(typeof res.body.id).toBe('string');
    expect(res.body.name).toBe('Alpha');
    expect(res.body.description).toBe('first');

    const mains = await db
      .select()
      .from(branches)
      .where(eq(branches.projectId, res.body.id));
    expect(mains.length).toBe(1);
    expect(mains[0].name).toBe('main');
  });

  it('GET /projects lists created projects', async () => {
    const server = app.getHttpServer();
    await request(server).post('/projects').send({ name: 'Alpha' }).expect(201);
    await request(server).post('/projects').send({ name: 'Beta' }).expect(201);

    const list = await request(server).get('/projects').expect(200);
    const names = (list.body as { name: string }[]).map((p) => p.name);
    // The demo "CorpDigi" project is re-seeded by truncateAll (it must persist
    // for v1 suites sharing this DB), so assert containment of the two we made.
    expect(names).toContain('Alpha');
    expect(names).toContain('Beta');
  });

  it('two projects ⇒ two distinct main branches', async () => {
    const server = app.getHttpServer();
    const a = await request(server).post('/projects').send({ name: 'Alpha' }).expect(201);
    const b = await request(server).post('/projects').send({ name: 'Beta' }).expect(201);

    const mainA = await db.select().from(branches).where(eq(branches.projectId, a.body.id));
    const mainB = await db.select().from(branches).where(eq(branches.projectId, b.body.id));
    expect(mainA.length).toBe(1);
    expect(mainB.length).toBe(1);
    expect(mainA[0].id).not.toBe(mainB[0].id);
  });

  it('GET /projects/:id returns it; unknown ⇒ 404', async () => {
    const server = app.getHttpServer();
    const created = await request(server).post('/projects').send({ name: 'Gamma' }).expect(201);
    const got = await request(server).get(`/projects/${created.body.id}`).expect(200);
    expect(got.body.name).toBe('Gamma');
    await request(server)
      .get('/projects/00000000-0000-0000-0000-000000000000')
      .expect(404);
  });

  it('PATCH /projects/:id renames; unknown ⇒ 404', async () => {
    const server = app.getHttpServer();
    const created = await request(server).post('/projects').send({ name: 'Delta' }).expect(201);
    const patched = await request(server)
      .patch(`/projects/${created.body.id}`)
      .send({ name: 'Delta-2' })
      .expect(200);
    expect(patched.body.name).toBe('Delta-2');
    await request(server)
      .patch('/projects/00000000-0000-0000-0000-000000000000')
      .send({ name: 'x' })
      .expect(404);
  });

  it('DELETE /projects/:id removes it (cascades branches); unknown ⇒ 404', async () => {
    const server = app.getHttpServer();
    const created = await request(server).post('/projects').send({ name: 'Epsilon' }).expect(201);
    await request(server).delete(`/projects/${created.body.id}`).expect(200);
    await request(server).get(`/projects/${created.body.id}`).expect(404);
    const remaining = await db
      .select()
      .from(branches)
      .where(eq(branches.projectId, created.body.id));
    expect(remaining.length).toBe(0);
    await request(server)
      .delete('/projects/00000000-0000-0000-0000-000000000000')
      .expect(404);
  });

  it('POST /projects with empty name ⇒ 400', async () => {
    const server = app.getHttpServer();
    await request(server).post('/projects').send({ description: 'no name' }).expect(400);
  });
});
