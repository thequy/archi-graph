// e2e tests for the GLOBAL pattern catalog HTTP surface.
//
//   GET    /patterns                 -> Pattern[]
//   GET    /patterns/:slug           -> Pattern | 404
//   POST   /patterns                 -> Pattern (201)
//   PATCH  /patterns/:slug           -> Pattern | 404
//   DELETE /patterns/:slug           -> 200 | 404
//   GET    /patterns/:slug/used-by   -> UsedByItem[]   (main branches only)
//
// Boots the whole AppModule against a REAL Postgres+pgvector (podman, 5434) via
// the NestJS testing module. The catalog is seeded (idempotent by slug) so the
// list is non-empty and includes 'singleton'. Tables truncated per test, then
// re-seeded (demo project + pattern catalog).

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
import { getDb, closeDb, type Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { AppModule } from '../app.module';
import { seedPatterns } from './pattern.service';
import { loadPatternsSeed } from '../boot/bootstrap-db';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5433/archigraph';

let app: INestApplication;
let db: Db;

async function truncateAndSeed(): Promise<void> {
  const { sql } = await import('drizzle-orm');
  await db.execute(
    sql`TRUNCATE TABLE
      patterns,
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
  // Seed the catalog so GET /patterns is non-empty (idempotent by slug).
  await seedPatterns(db, loadPatternsSeed());
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
  await truncateAndSeed();
});

describe('PatternsController (e2e)', () => {
  it('GET /patterns returns the seed (>0, includes singleton)', async () => {
    const server = app.getHttpServer();
    const res = await request(server).get('/patterns').expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    const slugs = (res.body as { slug: string }[]).map((p) => p.slug);
    expect(slugs).toContain('singleton');
  });

  it('GET /patterns/:slug returns one; unknown ⇒ 404', async () => {
    const server = app.getHttpServer();
    const got = await request(server).get('/patterns/singleton').expect(200);
    expect(got.body.slug).toBe('singleton');
    expect(got.body.category).toBe('gof');
    await request(server).get('/patterns/does-not-exist').expect(404);
  });

  it('POST creates; PATCH updates; DELETE removes', async () => {
    const server = app.getHttpServer();
    const created = await request(server)
      .post('/patterns')
      .send({
        slug: 'bulkhead',
        name: 'Bulkhead',
        category: 'system-design',
        intent: 'isolate resources',
        whenToUse: 'when isolating failures',
        pros: 'containment',
        cons: 'tuning',
      })
      .expect(201);
    expect(created.body.slug).toBe('bulkhead');
    expect(created.body.mermaid).toBeNull();

    const patched = await request(server)
      .patch('/patterns/bulkhead')
      .send({ intent: 'isolate pools of resources' })
      .expect(200);
    expect(patched.body.intent).toBe('isolate pools of resources');

    await request(server).delete('/patterns/bulkhead').expect(200);
    await request(server).get('/patterns/bulkhead').expect(404);
    await request(server).delete('/patterns/bulkhead').expect(404);
  });

  it('POST with invalid category ⇒ 400', async () => {
    const server = app.getHttpServer();
    await request(server)
      .post('/patterns')
      .send({
        slug: 'x',
        name: 'X',
        category: 'not-a-category',
        intent: 'i',
        whenToUse: 'w',
        pros: 'p',
        cons: 'c',
      })
      .expect(400);
  });

  it('GET /patterns/:slug/used-by reflects an entity applying it on project main', async () => {
    const server = app.getHttpServer();
    // Create a project (creates its own main branch), find that main branch id.
    const project = await request(server)
      .post('/projects')
      .send({ name: 'UsedByProj' })
      .expect(201);

    const { branches } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    const [main] = await db
      .select()
      .from(branches)
      .where(eq(branches.projectId, project.body.id));

    // Commit an entity applying 'outbox' on that main branch.
    await request(server)
      .post(`/branches/${main.id}/entities`)
      .send({
        entityId: 'E-outbox',
        type: 'sad',
        code: 'SAD-42',
        shortTitle: 's',
        group: 'soe',
        tier: 't0',
        title: 'Event Relay',
        metadata: { author: 'local', date: '2026-01-01', status: 'draft', tags: [] },
        contentMarkdown: '# relay',
        flow: null,
        links: [],
        appliesPatterns: ['outbox'],
      })
      .expect(201);

    const used = await request(server).get('/patterns/outbox/used-by').expect(200);
    expect(used.body).toEqual([
      {
        projectId: project.body.id,
        projectName: 'UsedByProj',
        entityId: 'E-outbox',
        code: 'SAD-42',
        title: 'Event Relay',
      },
    ]);

    // A slug nobody applies ⇒ empty array (no 404).
    const none = await request(server).get('/patterns/strategy/used-by').expect(200);
    expect(none.body).toEqual([]);
  });
});
