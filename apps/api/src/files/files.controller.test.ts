// e2e tests for the Files HTTP surface (Slice C — Upload).
//
//   POST /projects/:projectId/files   (multipart, 1 file) -> { fileId, summaryStatus }
//   GET  /files/:id/download                               -> streams the blob
//   GET  /files/:id                                        -> metadata
//
// Boots the whole AppModule against a REAL Postgres+pgvector (podman, 5434) via
// the NestJS testing module, exactly like the Projects e2e suite. The blob
// store writes to a THROWAWAY DATA_DIR (an OS temp dir created in beforeAll and
// removed in afterAll) so the suite never litters the repo.
//
// Pins the Task 7 contract:
//   1. POST a .md file to a project => 201 + a files row (project_id correct,
//      summary_status 'pending') + the blob exists on disk under
//      DATA_DIR/files/<projectId>/.
//   2. GET /files/:id/download returns the uploaded bytes verbatim.
//   3. A disallowed mime/extension (.exe / image/png) => 400 and NO files row /
//      NO blob written.
//   + over-size => 413/400; a path-traversal filename is sanitized.

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
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, closeDb, type Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { files, projects } from '../db/schema';
import { AppModule } from '../app.module';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5433/archigraph';

let app: INestApplication;
let db: Db;
let dataDir: string;
let projectId: string;

async function truncateAll(): Promise<void> {
  const { sql } = await import('drizzle-orm');
  await db.execute(
    sql`TRUNCATE TABLE
      files,
      embedding_jobs, doc_chunks,
      head_relations, head_entities,
      relation_versions, entity_versions,
      commits, branches, projects RESTART IDENTITY CASCADE`,
  );
  // Re-seed the demo project so v1 suites sharing this DB keep their FK.
  await db.execute(
    sql`INSERT INTO projects (id, name)
        VALUES ('11111111-1111-1111-1111-111111111111', 'CorpDigi')
        ON CONFLICT (id) DO NOTHING`,
  );
}

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  // Throwaway blob dir for the whole suite — set BEFORE the module compiles so
  // the storage provider factory reads it from the env.
  dataDir = await mkdtemp(join(tmpdir(), 'archi-graph-files-test-'));
  process.env.DATA_DIR = dataDir;

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
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  await truncateAll();
  // A fresh project to attach uploads to.
  const [row] = await db
    .insert(projects)
    .values({ name: 'FilesTestProject' })
    .returning();
  projectId = row.id;
});

describe('FilesController (e2e)', () => {
  it('POST .md => 201 + files row (project_id, pending) + blob on disk', async () => {
    const server = app.getHttpServer();
    const content = Buffer.from('# Hello\n\nThis is a markdown doc.\n');

    const res = await request(server)
      .post(`/projects/${projectId}/files`)
      .attach('file', content, {
        filename: 'notes.md',
        contentType: 'text/markdown',
      })
      .expect(201);

    expect(typeof res.body.fileId).toBe('string');
    expect(res.body.summaryStatus).toBe('pending');

    const rows = await db
      .select()
      .from(files)
      .where(eq(files.id, res.body.fileId));
    expect(rows).toHaveLength(1);
    expect(rows[0].projectId).toBe(projectId);
    expect(rows[0].summaryStatus).toBe('pending');
    expect(rows[0].filename).toBe('notes.md');
    expect(rows[0].sizeBytes).toBe(content.length);

    // Blob exists on disk under DATA_DIR/files/<projectId>/.
    const projectDir = join(dataDir, 'files', projectId);
    expect(existsSync(projectDir)).toBe(true);
    const entries = await readdir(projectDir);
    expect(entries.length).toBe(1);
    expect(entries[0]).toContain('notes.md');
    const blobStat = await stat(join(projectDir, entries[0]));
    expect(blobStat.size).toBe(content.length);
  });

  it('GET /files/:id/download returns the uploaded bytes', async () => {
    const server = app.getHttpServer();
    const content = Buffer.from('# Download me\n\nexact bytes here\n');

    const up = await request(server)
      .post(`/projects/${projectId}/files`)
      .attach('file', content, {
        filename: 'download.md',
        contentType: 'text/markdown',
      })
      .expect(201);

    const dl = await request(server)
      .get(`/files/${up.body.fileId}/download`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);

    expect(Buffer.compare(dl.body as Buffer, content)).toBe(0);
  });

  it('GET /files/:id returns metadata; unknown => 404', async () => {
    const server = app.getHttpServer();
    const content = Buffer.from('meta test\n');
    const up = await request(server)
      .post(`/projects/${projectId}/files`)
      .attach('file', content, {
        filename: 'meta.md',
        contentType: 'text/markdown',
      })
      .expect(201);

    const meta = await request(server)
      .get(`/files/${up.body.fileId}`)
      .expect(200);
    expect(meta.body.id).toBe(up.body.fileId);
    expect(meta.body.projectId).toBe(projectId);
    expect(meta.body.filename).toBe('meta.md');
    expect(meta.body.summaryStatus).toBe('pending');

    await request(server)
      .get('/files/00000000-0000-0000-0000-000000000000')
      .expect(404);
  });

  it('disallowed mime/extension (.exe) => 400 and NO files row / NO blob', async () => {
    const server = app.getHttpServer();
    await request(server)
      .post(`/projects/${projectId}/files`)
      .attach('file', Buffer.from('MZ\x90\x00'), {
        filename: 'malware.exe',
        contentType: 'application/octet-stream',
      })
      .expect(400);

    const rows = await db
      .select()
      .from(files)
      .where(eq(files.projectId, projectId));
    expect(rows).toHaveLength(0);

    const projectDir = join(dataDir, 'files', projectId);
    // Either the dir does not exist or it is empty — no blob written.
    if (existsSync(projectDir)) {
      const entries = await readdir(projectDir);
      expect(entries.length).toBe(0);
    }
  });

  it('disallowed mime (image/png) => 400', async () => {
    const server = app.getHttpServer();
    await request(server)
      .post(`/projects/${projectId}/files`)
      .attach('file', Buffer.from('\x89PNG\r\n'), {
        filename: 'pic.png',
        contentType: 'image/png',
      })
      .expect(400);

    const rows = await db
      .select()
      .from(files)
      .where(eq(files.projectId, projectId));
    expect(rows).toHaveLength(0);
  });

  it('over-size upload => 413/400 and NO files row', async () => {
    const server = app.getHttpServer();
    // 21 MB > 20 MB default limit.
    const big = Buffer.alloc(21 * 1024 * 1024, 0x61);
    const res = await request(server)
      .post(`/projects/${projectId}/files`)
      .attach('file', big, {
        filename: 'huge.md',
        contentType: 'text/markdown',
      });
    expect([400, 413]).toContain(res.status);

    const rows = await db
      .select()
      .from(files)
      .where(eq(files.projectId, projectId));
    expect(rows).toHaveLength(0);
  });

  it('path-traversal filename is sanitized (no escape from project dir)', async () => {
    const server = app.getHttpServer();
    const content = Buffer.from('traversal test\n');
    const up = await request(server)
      .post(`/projects/${projectId}/files`)
      .attach('file', content, {
        filename: '../../../../etc/passwd.md',
        contentType: 'text/markdown',
      })
      .expect(201);

    const rows = await db
      .select()
      .from(files)
      .where(eq(files.id, up.body.fileId));
    expect(rows).toHaveLength(1);
    // The stored blob must live UNDER the project dir — storage_path must start
    // with DATA_DIR/files/<projectId>/ and contain no parent-dir segments.
    const projectDir = join(dataDir, 'files', projectId);
    expect(rows[0].storagePath.startsWith(projectDir)).toBe(true);
    expect(rows[0].storagePath).not.toContain('..');
    expect(existsSync(rows[0].storagePath)).toBe(true);

    // The on-disk basename must not contain path separators beyond the uuid-name.
    const entries = await readdir(projectDir);
    expect(entries.length).toBe(1);
    expect(entries[0]).not.toContain('/');
    expect(entries[0]).not.toContain('\\');
  });
});
