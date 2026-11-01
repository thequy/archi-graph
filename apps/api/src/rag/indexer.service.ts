// IndexerService — the BACKGROUND embedding worker.
//
// The commit path (CommitService) only ENQUEUES a row into embedding_jobs for
// each add/update entity with non-empty contentMarkdown; it never embeds. That
// keeps commits fast and off the LLM critical path (Global Constraint: "Index
// runs OUTSIDE the commit path"). This service does the actual embedding work,
// asynchronously.
//
// runPending() drains all pending jobs:
//   for each job (entity_id, commit_id):
//     1. load that entity's content_markdown for THAT commit from the immutable
//        entity_versions row (entity_id, commit_id) — the exact content that
//        was committed when the job was enqueued;
//     2. chunk it (heading/paragraph-aware);
//     3. embed the chunks via the injected LlmPort (mock in tests);
//     4. UPSERT doc_chunks keyed by (entity_id, commit_id, chunk_index) — so a
//        re-run overwrites rather than duplicates; doc_chunks are shared across
//        branches (keyed by entity+commit, not branch);
//     5. mark the job 'done'.
// Returns the number of jobs processed. A second call processes 0 (idempotent)
// because all jobs are now 'done'.
//
// Designed to run as a background interval in prod (Task 12 wires the loop);
// invoked DIRECTLY in tests.

import { Injectable } from '@nestjs/common';
import { and, eq, gte } from 'drizzle-orm';
import type { Db } from '../db/client';
import { docChunks, embeddingJobs, entityVersions } from '../db/schema';
import type { LlmPort } from '../llm/llm.port';
import { chunkMarkdown } from './chunk';

@Injectable()
export class IndexerService {
  constructor(
    private readonly db: Db,
    private readonly llm: LlmPort,
  ) {}

  /**
   * Drains all pending embedding_jobs and returns the count processed.
   * Idempotent: once a job is 'done' it is never picked up again, so a second
   * call with no new commits returns 0.
   */
  async runPending(): Promise<number> {
    const pending = await this.db
      .select()
      .from(embeddingJobs)
      .where(eq(embeddingJobs.status, 'pending'));

    let processed = 0;
    for (const job of pending) {
      await this.processJob(job.id, job.entityId, job.commitId, job.projectId);
      processed += 1;
    }
    return processed;
  }

  private async processJob(
    jobId: string,
    entityId: string,
    commitId: string,
    projectId: string | null,
  ): Promise<void> {
    // Load the content committed for this exact (entity, commit).
    const versionRows = await this.db
      .select({ contentMarkdown: entityVersions.contentMarkdown })
      .from(entityVersions)
      .where(
        and(
          eq(entityVersions.entityId, entityId),
          eq(entityVersions.commitId, commitId),
        ),
      )
      .limit(1);

    const content = versionRows[0]?.contentMarkdown ?? '';
    const chunks = chunkMarkdown(content);

    if (chunks.length > 0) {
      const embeddings = await this.llm.embed(chunks.map((c) => c.text));

      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        const embedding = embeddings[i];
        await this.db
          .insert(docChunks)
          .values({
            entityId,
            commitId,
            // Project scope carried from the embedding_jobs row (set by the
            // commit from the branch's project_id). This is what lets
            // RagService enforce per-project isolation even when two projects
            // share a human-authored entity_id (Task 3).
            projectId,
            chunkIndex: chunk.index,
            text: chunk.text,
            embedding,
          })
          .onConflictDoUpdate({
            target: [
              docChunks.entityId,
              docChunks.commitId,
              docChunks.chunkIndex,
            ],
            set: { text: chunk.text, embedding, projectId },
          });
      }
    }

    // Purge any STALE tail rows. The upsert above overwrites chunks 0..N-1, but
    // a RE-INDEX that produces FEWER chunks than a prior run would otherwise
    // leave orphaned rows at chunk_index >= N (the old higher-index chunks).
    // Delete them so (entity_id, commit_id) holds exactly the current N chunks
    // — no stale tail. (When N === 0 this clears every chunk for the pair.)
    await this.db
      .delete(docChunks)
      .where(
        and(
          eq(docChunks.entityId, entityId),
          eq(docChunks.commitId, commitId),
          gte(docChunks.chunkIndex, chunks.length),
        ),
      );

    // Mark the job done regardless of whether it produced chunks (empty content
    // still completes the job so it is not retried forever).
    await this.db
      .update(embeddingJobs)
      .set({ status: 'done' })
      .where(eq(embeddingJobs.id, jobId));
  }
}
