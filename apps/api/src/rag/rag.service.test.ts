// Tests for the RAG indexer + query path.
//
// Runs against a REAL Postgres+pgvector (podman) via DATABASE_URL (so the
// pgvector `<=>` cosine operator and the branch head-state join are exercised
// for real). The LLM is a DETERMINISTIC MOCK LlmPort — no live Ollama.
//
// ─────────────────────────────────────────────────────────────────────────────
// How the mock makes similarity PREDICTABLE (documented):
//
//   embed(text) returns a 768-dim ONE-HOT vector whose single `1` sits at
//   dimension `hash(topic(text)) % 768`, where topic(text) is the FIRST WORD of
//   the text. Two texts about the same topic word therefore map to the SAME
//   basis vector (cosine distance 0); texts about different topic words map to
//   ORTHOGONAL vectors (cosine distance 1). Each seeded entity's content starts
//   with a unique topic word, so:
//     - a question whose first word is entity X's topic word embeds to X's
//       chunk vector exactly ⇒ X's chunk is the unique nearest neighbour
//       (distance 0) ⇒ X is the top citation, deterministically.
//   complete() just echoes the number of context chunks so the answer is
//   deterministic and obviously grounded.
//
// 768 is the real column dimension (doc_chunks.embedding = vector(768)); the
// mock returns true 768-dim vectors, matching the column exactly.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import type { Entity } from '@archi-graph/shared';
import { getDb, closeDb, type Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { CommitService, ensureMainBranch } from '../model/commit.service';
import { EMBED_DIM, type LlmPort } from '../llm/llm.port';
import { IndexerService } from './indexer.service';
import { RagService, NO_INDEXED_CONTENT } from './rag.service';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5433/archigraph';

let db: Db;
let commits: CommitService;

/** FNV-1a hash → non-negative int, used to pick a stable one-hot dimension. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** First word (topic) of a text, lowercased. */
function topic(text: string): string {
  const m = text.toLowerCase().match(/[a-z0-9]+/);
  return m ? m[0] : '';
}

/** Deterministic mock LlmPort: one-hot embeddings keyed on topic word. */
class MockLlm implements LlmPort {
  public lastContext: string[] | undefined;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(EMBED_DIM).fill(0);
      v[hash(topic(t)) % EMBED_DIM] = 1;
      return v;
    });
  }

  async complete(_prompt: string, context: string[]): Promise<string> {
    this.lastContext = context;
    return `answer from ${context.length} chunk(s)`;
  }
}

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
}, 60_000);

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
});

describe('IndexerService.runPending', () => {
  it('embeds pending jobs, upserts doc_chunks, marks jobs done, and is idempotent', async () => {
    const branchId = await ensureMainBranch(db);
    const llm = new MockLlm();
    const indexer = new IndexerService(db, llm);

    await commits.commit(
      branchId,
      {
        entities: [
          makeEntity({ entityId: 'A', contentMarkdown: 'alpha subject text' }),
          makeEntity({ entityId: 'B', contentMarkdown: 'bravo subject text' }),
        ].map((entity) => ({ op: 'add' as const, entity })),
        relations: [],
      },
      'seed two entities',
    );

    const { sql } = await import('drizzle-orm');

    // Two pending jobs enqueued by the commit.
    const pendingBefore = await db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM embedding_jobs WHERE status = 'pending'`,
    );
    expect(Number(pendingBefore.rows[0].n)).toBe(2);

    // First drain processes both jobs.
    expect(await indexer.runPending()).toBe(2);

    const chunks = await db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM doc_chunks`,
    );
    expect(Number(chunks.rows[0].n)).toBeGreaterThanOrEqual(2);

    const doneAfter = await db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM embedding_jobs WHERE status = 'done'`,
    );
    expect(Number(doneAfter.rows[0].n)).toBe(2);

    // Idempotent: a second drain with no new commits processes 0 and does not
    // duplicate doc_chunks (UPSERT on (entity_id, commit_id, chunk_index)).
    expect(await indexer.runPending()).toBe(0);
    const chunks2 = await db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM doc_chunks`,
    );
    expect(Number(chunks2.rows[0].n)).toBe(Number(chunks.rows[0].n));
  });

  it('a re-index that produces FEWER chunks leaves no stale tail rows', async () => {
    const branchId = await ensureMainBranch(db);
    const llm = new MockLlm();
    const indexer = new IndexerService(db, llm);
    const { sql } = await import('drizzle-orm');

    // A doc with several headed sections → MULTIPLE chunks.
    const para = (n: number): string =>
      `paragraph ${n}. ` + 'lorem ipsum dolor sit amet. '.repeat(10);
    const bigDoc = [
      '# One',
      para(1),
      '## Two',
      para(2),
      '## Three',
      para(3),
      '# Four',
      para(4),
    ].join('\n\n');

    const { commitId } = await commits.commit(
      branchId,
      {
        entities: [
          { op: 'add', entity: makeEntity({ entityId: 'BIG', contentMarkdown: bigDoc }) },
        ],
        relations: [],
      },
      'seed BIG with a multi-chunk doc',
    );

    // First index — produces N > 1 chunks for (BIG, commitId).
    await indexer.runPending();
    const firstCount = await db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM doc_chunks WHERE entity_id = 'BIG' AND commit_id = ${commitId}`,
    );
    const n1 = Number(firstCount.rows[0].n);
    expect(n1).toBeGreaterThan(1);

    // Simulate a RE-INDEX that yields FEWER chunks: shrink the committed
    // content for that exact (entity, commit) to a single short block, then
    // re-enqueue a pending job for the SAME (entity_id, commit_id). This mirrors
    // a re-run whose fresh chunk count is lower than the prior run.
    await db.execute(
      sql`UPDATE entity_versions SET content_markdown = 'only one short block'
          WHERE entity_id = 'BIG' AND commit_id = ${commitId}`,
    );
    await db.execute(
      sql`INSERT INTO embedding_jobs (entity_id, commit_id, status)
          VALUES ('BIG', ${commitId}, 'pending')`,
    );

    // Second drain re-indexes BIG; the new content yields exactly ONE chunk.
    expect(await indexer.runPending()).toBe(1);

    const rows = await db.execute<{ chunk_index: number }>(
      sql`SELECT chunk_index FROM doc_chunks
          WHERE entity_id = 'BIG' AND commit_id = ${commitId}
          ORDER BY chunk_index`,
    );
    // Exactly the current chunk set (index 0), no stale tail at index >= 1.
    expect(rows.rows.map((r) => Number(r.chunk_index))).toEqual([0]);
  });
});

describe('RagService.query', () => {
  it('returns an answer whose citations include the entity best matching the question', async () => {
    const branchId = await ensureMainBranch(db);
    const llm = new MockLlm();
    const indexer = new IndexerService(db, llm);
    const rag = new RagService(db, llm);

    // Three entities, each with a DISTINCT topic word as the first word.
    await commits.commit(
      branchId,
      {
        entities: [
          makeEntity({
            entityId: 'AUTH',
            code: 'SAD-AUTH',
            shortTitle: 'Auth service',
            contentMarkdown: 'authentication handles login and sessions',
          }),
          makeEntity({
            entityId: 'BILL',
            code: 'SAD-BILL',
            shortTitle: 'Billing service',
            contentMarkdown: 'billing computes invoices and charges',
          }),
          makeEntity({
            entityId: 'SEARCH',
            code: 'SAD-SRCH',
            shortTitle: 'Search service',
            contentMarkdown: 'search indexes documents for retrieval',
          }),
        ].map((entity) => ({ op: 'add' as const, entity })),
        relations: [],
      },
      'seed three entities',
    );

    await indexer.runPending();

    // Question topic word "billing" ⇒ matches the BILL entity's chunk exactly.
    const answer = await rag.query(branchId, 'billing question about charges');

    expect(answer.answer).toContain('chunk');
    expect(answer.citations.length).toBeGreaterThanOrEqual(1);
    // Top citation is the best match: BILL.
    expect(answer.citations[0].entityId).toBe('BILL');
    expect(answer.citations[0].code).toBe('SAD-BILL');
    expect(answer.citations[0].shortTitle).toBe('Billing service');
  });

  it('REVIEW FOCUS: querying a branch with NO chunks returns empty citations + 200 (no throw)', async () => {
    const branchId = await ensureMainBranch(db);
    const llm = new MockLlm();
    const rag = new RagService(db, llm);

    // No commits, no indexing ⇒ no doc_chunks for this branch.
    const answer = await rag.query(branchId, 'anything at all');

    expect(answer).toEqual({ answer: NO_INDEXED_CONTENT, citations: [] });
  });

  it('does not cite a chunk whose entity is not in THIS branch head-state', async () => {
    // Entity on main gets indexed. A second branch with no head entities must
    // not retrieve main's chunk even though doc_chunks are shared.
    const mainId = await ensureMainBranch(db);
    const llm = new MockLlm();
    const indexer = new IndexerService(db, llm);
    const rag = new RagService(db, llm);

    await commits.commit(
      mainId,
      {
        entities: [
          {
            op: 'add',
            entity: makeEntity({
              entityId: 'AUTH',
              contentMarkdown: 'authentication handles login',
            }),
          },
        ],
        relations: [],
      },
      'seed auth on main',
    );
    await indexer.runPending();

    // A fresh branch row with NO head_entities.
    const { sql } = await import('drizzle-orm');
    const other = await db.execute<{ id: string }>(
      sql`INSERT INTO branches (name, author) VALUES ('other', 'local') RETURNING id`,
    );
    const otherId = other.rows[0].id;

    const answer = await rag.query(otherId, 'authentication question');
    expect(answer).toEqual({ answer: NO_INDEXED_CONTENT, citations: [] });

    // But main DOES retrieve it.
    const mainAnswer = await rag.query(mainId, 'authentication question');
    expect(mainAnswer.citations[0].entityId).toBe('AUTH');
  });
});
