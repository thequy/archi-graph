// Files service (Slice C — Upload). Persists an uploaded blob via the blob
// store and records a `files` row, then exposes read access by id.
//
// save() does the MINIMUM work and returns promptly: write the blob + insert a
// row with summary_status 'pending'. It does NOT extract text or call the LLM —
// Task 8's ingest pipeline does that in the background, keyed off the pending
// row. This keeps the POST upload request fast (Global Constraint: upload must
// not block on heavy work).

import { NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Readable } from 'node:stream';
import type { Db } from '../db/client';
import { files, projects } from '../db/schema';
import type { BlobStore } from './storage';

/** A persisted file row (shape of db.files rows). */
export type FileRow = typeof files.$inferSelect;

/** The minimal uploaded-file shape the service needs (decoupled from multer). */
export interface UploadedFileInput {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export class FilesService {
  constructor(
    private readonly db: Db,
    private readonly storage: BlobStore,
  ) {}

  /**
   * Stores the blob and inserts a `files` row (summary_status 'pending').
   * Returns the inserted row. Fast by design — no extraction / LLM here.
   *
   * Before touching the blob store we verify the project exists. A
   * syntactically-valid UUID that references no real project (deleted / typo'd)
   * would otherwise pass ParseUUIDPipe, get a blob written, then raise a raw
   * Postgres FK violation on insert — which surfaces as a 500. We short-circuit
   * that common case with a 404 NotFoundException and write no blob at all.
   *
   * The blob is written to disk BEFORE the row insert. If the insert still
   * throws for any OTHER reason, the just-written blob would be orphaned on
   * disk (Task 8 keys off rows, so it would never be referenced or cleaned up).
   * So on insert failure we best-effort unlink the blob before rethrowing — no
   * orphan left behind.
   */
  async save(projectId: string, file: UploadedFileInput): Promise<FileRow> {
    // Project must exist before we write anything. Avoids an orphan-blob path
    // and gives the client a 404 instead of a 500 for a nonexistent project.
    const existing = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (existing.length === 0) {
      throw new NotFoundException(`project not found: ${projectId}`);
    }

    const storagePath = await this.storage.save(
      projectId,
      file.originalname,
      file.buffer,
    );
    try {
      const [row] = await this.db
        .insert(files)
        .values({
          projectId,
          filename: file.originalname,
          mime: file.mimetype,
          sizeBytes: file.size,
          storagePath,
          summaryStatus: 'pending',
        })
        .returning();
      return row;
    } catch (err) {
      // Row insert failed — remove the orphan blob (best effort; swallow any
      // unlink error so the original DB error is what surfaces).
      await this.storage.deletePath(storagePath).catch(() => undefined);
      throw err;
    }
  }

  /** Returns the file row by id, or null if it does not exist. */
  async get(id: string): Promise<FileRow | null> {
    const rows = await this.db.select().from(files).where(eq(files.id, id));
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Opens a read stream over the stored blob for `id`. Returns null if the file
   * row does not exist (so the controller can map it to a 404).
   */
  async openReadStream(
    id: string,
  ): Promise<{ row: FileRow; stream: Readable } | null> {
    const row = await this.get(id);
    if (!row) return null;
    return { row, stream: this.storage.openStream(row.storagePath) };
  }
}
