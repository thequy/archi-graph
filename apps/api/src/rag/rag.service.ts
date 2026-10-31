// RagService — retrieval-augmented question answering over a branch.
//
// query(branchId, question):
//   1. embed the question via the injected LlmPort (mock in tests);
//   2. retrieve the top-k doc_chunks BY pgvector cosine distance, RESTRICTED to
//      the entity ids present in THIS branch's materialized head-state
//      (head_entities). doc_chunks are shared across branches (keyed by
//      entity+commit), so the branch restriction is what makes an answer
//      branch-specific: a chunk from an entity not in this branch's head is
//      never retrieved and never cited (Global Constraint);
//   3. build a prompt from the retrieved chunk texts and call complete();
//   4. return { answer, citations } where each citation carries
//      entityId + code + shortTitle looked up from the branch head-state.
//
// EMPTY / UN-INDEXED branch (no retrievable chunks) ⇒
//   { answer: '<no indexed content>', citations: [] }  with HTTP 200.
// This is a Review Focus: an empty branch is a normal, successful answer — NOT
// an error/500.
//
// ─────────────────────────────────────────────────────────────────────────────
// pgvector query shape:
//   doc_chunks.embedding is vector(768). We compare with the cosine-distance
//   operator `<=>` against the question embedding formatted as a pgvector
//   literal string `[v1,v2,...]`. Smaller distance = more similar, so we
//   ORDER BY embedding <=> $q ASC and LIMIT k. The chunk's entity_id is joined
//   against this branch's head_entities to enforce the branch restriction and
//   to pull code / short_title for the citation in one pass.

import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Citation, RagAnswer } from '@archi-graph/shared';
import type { Db } from '../db/client';
import type { LlmPort } from '../llm/llm.port';

/** Sentinel answer for an empty / un-indexed branch. */
export const NO_INDEXED_CONTENT = '<no indexed content>';

/** Default number of chunks to retrieve. */
const DEFAULT_TOP_K = 5;

interface RetrievedRow {
  entity_id: string;
  code: string;
  short_title: string;
  text: string;
  distance: number;
}

@Injectable()
export class RagService {
  constructor(
    private readonly db: Db,
    private readonly llm: LlmPort,
  ) {}

  async query(
    branchId: string,
    question: string,
    topK: number = DEFAULT_TOP_K,
  ): Promise<RagAnswer> {
    // 1. Embed the question. embed() returns one vector per input; we pass one.
    const [questionEmbedding] = await this.llm.embed([question]);

    // 2. Retrieve top-k chunks restricted to this branch's head-state entities.
    const rows = await this.retrieve(branchId, questionEmbedding, topK);

    // 3. Empty / un-indexed branch ⇒ successful empty answer (NOT an error).
    if (rows.length === 0) {
      return { answer: NO_INDEXED_CONTENT, citations: [] };
    }

    // 4. Build the prompt from retrieved context and generate an answer.
    const context = rows.map((r) => r.text);
    const prompt = `Answer the question using only the provided context.\n\nQuestion: ${question}`;
    const answer = await this.llm.complete(prompt, context);

    // 5. Citations: one per DISTINCT source entity, in retrieval (relevance)
    //    order. Every answer ties to >=1 entity_id source (Global Constraint).
    const citations = this.toCitations(rows);

    return { answer, citations };
  }

  /** pgvector cosine top-k, joined to this branch's head_entities. */
  private async retrieve(
    branchId: string,
    questionEmbedding: number[],
    topK: number,
  ): Promise<RetrievedRow[]> {
    // Format the embedding as a pgvector literal: [v1,v2,...].
    const vectorLiteral = `[${questionEmbedding.join(',')}]`;

    const query = sql`
      SELECT
        dc.entity_id    AS entity_id,
        he.code         AS code,
        he.short_title  AS short_title,
        dc.text         AS text,
        (dc.embedding <=> ${vectorLiteral}::vector) AS distance
      FROM doc_chunks dc
      JOIN head_entities he
        ON he.entity_id = dc.entity_id
       AND he.branch_id = ${branchId}
      WHERE dc.embedding IS NOT NULL
      ORDER BY dc.embedding <=> ${vectorLiteral}::vector ASC
      LIMIT ${topK}
    `;

    const res = await this.db.execute(query);
    return (res.rows as unknown as RetrievedRow[]).map((r) => ({
      entity_id: r.entity_id,
      code: r.code,
      short_title: r.short_title,
      text: r.text,
      distance: Number(r.distance),
    }));
  }

  /** De-duplicate retrieved rows to one Citation per entity, in rank order. */
  private toCitations(rows: RetrievedRow[]): Citation[] {
    const seen = new Set<string>();
    const citations: Citation[] = [];
    for (const r of rows) {
      if (seen.has(r.entity_id)) continue;
      seen.add(r.entity_id);
      citations.push({
        entityId: r.entity_id,
        code: r.code,
        shortTitle: r.short_title,
      });
    }
    return citations;
  }
}
