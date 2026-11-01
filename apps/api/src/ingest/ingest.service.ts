// IngestService — the BACKGROUND summarize+index pipeline (Slice C, Task 8).
//
// Upload (Task 7) is deliberately cheap: POST writes the blob and inserts a
// `files` row with summary_status='pending', entity_id NULL, extracted_chars
// NULL — then returns. This service drains those pending rows OFF the request
// path (the worker loop calls runPending() on an interval, alongside the
// embedding IndexerService).
//
// Per pending file, runPending():
//   1. extractText(storage_path, mime) — mammoth/pdf-parse/read (extract.ts).
//      Empty content or a parse failure throws a classified ExtractError.
//   2. LlmPort.complete(prompt, [text]) — a SHORT summary of the document.
//   3. ensureProjectMain(db, file.project_id) — the project's `main` branch.
//   4. CommitService.commit(...) — adds a *document* entity whose
//      contentMarkdown is the summary plus a footer line linking the original
//      file (/files/:id/download). Because this goes through commit, the entity
//      is versioned AND an embedding_jobs row is enqueued WITH project_id, so
//      the indexer embeds it and RAG can answer about the upload, isolated to
//      this project.
//   5. Mark the file row: entity_id = new entity, extracted_chars = text.length,
//      summary_status = 'done'.
//
// FAILURE HANDLING (Review Focus — Global Constraint):
//   Any error for ONE file (extraction empty/failed, LLM error, commit error)
//   is caught inside the per-file loop; that file's summary_status is set to
//   'failed' and the loop CONTINUES with the next file. A bad file never:
//     - stays 'pending' forever (it becomes 'failed'), nor
//     - aborts the whole drain (the error does not propagate out of runPending).
//
// IDEMPOTENCY:
//   Only rows with summary_status='pending' are selected. 'done'/'failed' rows
//   are never reprocessed, so a second runPending() with nothing pending does
//   0 work and returns 0.
//
// DEFAULT DOCUMENT ENTITY SHAPE (builder's choice, documented):
//   type  = 'tsd'  (Technical Specification Document — the closest fit for an
//                   arbitrary uploaded source doc in the v1 type set).
//   group = 'soda' (System-of-Documents/Artifacts bucket — uploads are source
//                   artifacts, not a specific system-of-* domain).
//   tier  = 'tx'   (the catch-all/unclassified tier).
//   code  = 'DOC-<short id>' derived from the generated entityId so it is
//           stable and unique per upload.
//   entityId is a fresh UUID ('upload-' prefixed) so repeated uploads of the
//   same filename never collide / overwrite each other.

import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Entity } from '@archi-graph/shared';
import type { Db } from '../db/client';
import { files } from '../db/schema';
import type { LlmPort } from '../llm/llm.port';
import { CommitService, ensureProjectMain } from '../model/commit.service';
import { extractText } from './extract';

/** Prompt handed to LlmPort.complete; the extracted text is the single context. */
const SUMMARY_PROMPT =
  'Summarize the following document in a few clear sentences. ' +
  'Capture its purpose and key points for an architecture knowledge base. ' +
  'Return only the summary text.';

@Injectable()
export class IngestService {
  private readonly commits: CommitService;

  constructor(
    private readonly db: Db,
    private readonly llm: LlmPort,
  ) {
    this.commits = new CommitService(db);
  }

  /**
   * Drains all `files` rows with summary_status='pending' and returns the
   * count of rows HANDLED (done OR failed). Never throws for a single bad file
   * (that file becomes 'failed' and the drain continues). Idempotent: a second
   * call with nothing pending returns 0.
   */
  async runPending(): Promise<number> {
    const pending = await this.db
      .select()
      .from(files)
      .where(eq(files.summaryStatus, 'pending'));

    let handled = 0;
    for (const file of pending) {
      try {
        await this.processFile(file);
      } catch (err) {
        // A single bad file must NOT abort the drain or stay 'pending'.
        await this.markFailed(file.id, err);
      }
      handled += 1;
    }
    return handled;
  }

  private async processFile(
    file: typeof files.$inferSelect,
  ): Promise<void> {
    // 1. Extract text (throws a classified ExtractError on empty/parse-fail).
    const text = await extractText(file.storagePath, file.mime);

    // 2. Summarize via the injected LLM (mock in tests).
    const summary = (await this.llm.complete(SUMMARY_PROMPT, [text])).trim();

    // 3. The project's main branch (created on demand, project-scoped).
    const branchId = await ensureProjectMain(this.db, file.projectId);

    // 4. Build the document entity and commit it onto main. The commit enqueues
    //    an embedding_jobs row (with project_id) because contentMarkdown is
    //    non-empty, so the indexer/RAG picks it up, isolated per project.
    const entityId = `upload-${randomUUID()}`;
    const entity = this.buildEntity(entityId, file, summary);
    await this.commits.commit(
      branchId,
      { entities: [{ op: 'add', entity }], relations: [] },
      `ingest: summarize upload ${file.filename}`,
    );

    // 5. Link the file row to its entity and mark it done.
    await this.db
      .update(files)
      .set({
        entityId,
        extractedChars: text.length,
        summaryStatus: 'done',
      })
      .where(eq(files.id, file.id));
  }

  /**
   * Builds the default "uploaded document" entity. contentMarkdown is the LLM
   * summary followed by a footer linking back to the original file so a reader
   * (and RAG) can find the source blob.
   */
  private buildEntity(
    entityId: string,
    file: typeof files.$inferSelect,
    summary: string,
  ): Entity {
    const today = new Date().toISOString().slice(0, 10);
    const shortId = entityId.slice(-8);
    const downloadPath = `/files/${file.id}/download`;
    const contentMarkdown =
      `${summary}\n\n` +
      `---\n` +
      `Source file: [${file.filename}](${downloadPath})\n`;

    return {
      entityId,
      type: 'tsd',
      code: `DOC-${shortId}`,
      shortTitle: file.filename,
      group: 'soda',
      tier: 'tx',
      title: file.filename,
      metadata: {
        author: 'local',
        date: today,
        status: 'imported',
        tags: ['upload'],
      },
      contentMarkdown,
      flow: null,
      links: [
        {
          provider: 'other',
          name: file.filename,
          url: downloadPath,
        },
      ],
    };
  }

  /** Marks one file 'failed' (best-effort; swallows a secondary update error). */
  private async markFailed(fileId: string, err: unknown): Promise<void> {
    // eslint-disable-next-line no-console
    console.error(`ingest: file ${fileId} failed, marking 'failed':`, err);
    try {
      await this.db
        .update(files)
        .set({ summaryStatus: 'failed' })
        .where(eq(files.id, fileId));
    } catch (updateErr) {
      // A secondary failure updating the status must not re-abort the drain.
      // eslint-disable-next-line no-console
      console.error(
        `ingest: could not mark file ${fileId} 'failed':`,
        updateErr,
      );
    }
  }
}
