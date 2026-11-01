// Tests for IngestService.runPending (Slice C — Ingest, Task 8).
//
// Runs against a REAL Postgres+pgvector (podman, 5434) via DATABASE_URL and a
// THROWAWAY DATA_DIR for blobs. The LLM is a DETERMINISTIC MOCK LlmPort whose
// complete() returns a FIXED summary string — no live Ollama.
//
// Pins the Task 8 contract:
//   1. A single 'pending' .md file =>
//        - runPending() returns 1 and creates an entity on the project's main
//          branch whose contentMarkdown contains the mock summary;
//        - files.entity_id is set to that entity, files.extracted_chars = the
//          extracted text length, files.summary_status = 'done';
//        - a SECOND runPending() processes 0 (idempotent — 'done' not re-run).
//   2. (Review Focus) a 'pending' file whose extraction fails (empty blob) =>
//        summary_status flips to 'failed', the OTHER pending file in the same
//        drain is still processed to 'done', and runPending DOES NOT throw.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb, closeDb, type Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { files, projects, headEntities } from '../db/schema';
import { ensureProjectMain } from '../model/commit.service';
import type { LlmPort } from '../llm/llm.port';
import { IngestService } from './ingest.service';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5433/archigraph';

const MOCK_SUMMARY = 'This document is a concise mock summary of the upload.';

/** Deterministic mock LlmPort: complete() always returns the fixed summary. */
class MockLlm implements LlmPort {
  public completeCalls = 0;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => new Array<number>(768).fill(0));
  }
  async complete(_prompt: string, _context: string[]): Promise<string> {
    this.completeCalls += 1;
    return MOCK_SUMMARY;
  }
}

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
  await db.execute(
    sql`INSERT INTO projects (id, name)
        VALUES ('11111111-1111-1111-1111-111111111111', 'CorpDigi')
        ON CONFLICT (id) DO NOTHING`,
  );
}

/** Writes a blob under DATA_DIR/files/<projectId>/ and inserts a pending row. */
async function seedPendingFile(
  pid: string,
  filename: string,
  mime: string,
  content: Buffer,
): Promise<string> {
  const dir = join(dataDir, 'files', pid);
  await mkdir(dir, { recursive: true });
  const storagePath = join(dir, `${randomUUID()}-${filename}`);
  await writeFile(storagePath, content);
  const [row] = await db
    .insert(files)
    .values({
      projectId: pid,
      filename,
      mime,
      sizeBytes: content.length,
      storagePath,
      summaryStatus: 'pending',
    })
    .returning();
  return row.id;
}

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  dataDir = await mkdtemp(join(tmpdir(), 'archi-graph-ingest-test-'));
  process.env.DATA_DIR = dataDir;
  await runMigrations(DATABASE_URL);
  db = getDb(DATABASE_URL);
}, 60_000);

afterAll(async () => {
  await closeDb();
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  await truncateAll();
  const [row] = await db
    .insert(projects)
    .values({ name: 'IngestTestProject' })
    .returning();
  projectId = row.id;
});

describe('IngestService.runPending', () => {
  it('summarizes a pending .md file -> entity on main + done + idempotent', async () => {
    const content = Buffer.from('# Spec\n\nImportant architecture notes here.\n');
    const fileId = await seedPendingFile(
      projectId,
      'spec.md',
      'text/markdown',
      content,
    );

    const llm = new MockLlm();
    const service = new IngestService(db, llm);

    const processed = await service.runPending();
    expect(processed).toBe(1);
    expect(llm.completeCalls).toBe(1);

    // The file row is now done, linked to an entity, with extracted_chars set.
    const [fileRow] = await db
      .select()
      .from(files)
      .where(eq(files.id, fileId));
    expect(fileRow.summaryStatus).toBe('done');
    expect(fileRow.entityId).toBeTruthy();
    expect(fileRow.extractedChars).toBe(content.toString('utf8').length);

    // The entity exists on the project's main head-state with the mock summary
    // as its contentMarkdown.
    const branchId = await ensureProjectMain(db, projectId);
    const heads = await db
      .select()
      .from(headEntities)
      .where(eq(headEntities.entityId, fileRow.entityId as string));
    expect(heads).toHaveLength(1);
    expect(heads[0].branchId).toBe(branchId);
    expect(heads[0].contentMarkdown).toContain(MOCK_SUMMARY);

    // Idempotent: nothing pending the second time.
    const again = await service.runPending();
    expect(again).toBe(0);
  });

  it('(Review Focus) a failing extraction marks that file failed, still processes others, does NOT throw', async () => {
    // One good file + one empty file (extraction fails). Both pending.
    const good = Buffer.from('# Good\n\nReal content to summarize.\n');
    const goodId = await seedPendingFile(
      projectId,
      'good.md',
      'text/markdown',
      good,
    );
    const emptyId = await seedPendingFile(
      projectId,
      'empty.md',
      'text/markdown',
      Buffer.from(''),
    );

    const llm = new MockLlm();
    const service = new IngestService(db, llm);

    // MUST NOT throw even though one file fails extraction.
    const processed = await service.runPending();
    // Both pending rows were handled (one done, one failed).
    expect(processed).toBe(2);

    const [goodRow] = await db
      .select()
      .from(files)
      .where(eq(files.id, goodId));
    expect(goodRow.summaryStatus).toBe('done');
    expect(goodRow.entityId).toBeTruthy();

    const [emptyRow] = await db
      .select()
      .from(files)
      .where(eq(files.id, emptyId));
    expect(emptyRow.summaryStatus).toBe('failed');
    expect(emptyRow.entityId).toBeNull();

    // Not stuck pending, and a re-drain finds nothing to do.
    const again = await service.runPending();
    expect(again).toBe(0);
  });
});
