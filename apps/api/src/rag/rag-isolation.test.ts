// RAG PROJECT ISOLATION — the whole point of Task 3 (Review Focus).
//
// doc_chunks / embedding_jobs are keyed by entity_id + commit_id with NO
// project scope, and RagService.retrieve() joins only on entity_id + branch_id.
// Entity ids are human-authored, so TWO projects can hold the SAME entity_id
// (e.g. 'foo') with DIFFERENT content. Without a project predicate, a query on
// project A's branch could retrieve project B's chunk for 'foo' (cross-project
// contamination). This suite proves the isolation boundary: RagService.query on
// project A's main must return ONLY A's chunk/citation for 'foo', never B's,
// even though the entity_id is identical.
//
// Enforcement under test: doc_chunks.project_id = (project_id of the queried
// branch), added to the retrieve() query IN ADDITION to the head_entities join.
//
// Runs against a REAL Postgres+pgvector (podman, 5434). The LLM is a
// DETERMINISTIC MOCK (same one-hot-by-topic-word scheme as rag.service.test.ts)
// so the nearest-neighbour match is predictable: the key assertion is that B's
// chunk is NEVER retrieved for an A query even when entity_id collides.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { eq } from 'drizzle-orm';
import type { Entity } from '@archi-graph/shared';
import { getDb, closeDb, type Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { branches } from '../db/schema';
import { CommitService, ensureProjectMain } from '../model/commit.service';
import { ProjectService } from '../projects/project.service';
import { EMBED_DIM, type LlmPort } from '../llm/llm.port';
import { IndexerService } from './indexer.service';
import { RagService } from './rag.service';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5433/archigraph';

let db: Db;
let commits: CommitService;
let projectService: ProjectService;

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
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(EMBED_DIM).fill(0);
      v[hash(topic(t)) % EMBED_DIM] = 1;
      return v;
    });
  }

  async complete(_prompt: string, context: string[]): Promise<string> {
    // Echo the retrieved context so tests can assert WHICH chunks were used
    // (and thus prove a cross-project chunk was never retrieved).
    return `answer[${context.join(' | ')}]`;
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
      commits, branches, projects RESTART IDENTITY CASCADE`,
  );
  // This suite truncates `projects` (CASCADE clears branches). The shared
  // podman DB is reused across ALL api suites sequentially; v1 suites rely on
  // the backfilled demo project existing so ensureMainBranch's FK holds. Re-seed
  // it so wiping projects here does not break a later suite.
  await db.execute(
    sql`INSERT INTO projects (id, name)
        VALUES ('11111111-1111-1111-1111-111111111111', 'CorpDigi')
        ON CONFLICT (id) DO NOTHING`,
  );
}

/** Resolve the main branch id of a project. */
async function mainBranchOf(projectId: string): Promise<string> {
  return ensureProjectMain(db, projectId);
}

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  await runMigrations(DATABASE_URL);
  db = getDb(DATABASE_URL);
  commits = new CommitService(db);
  projectService = new ProjectService(db);
}, 60_000);

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
});

describe('RAG project isolation (Review Focus)', () => {
  it('query on project A never retrieves project B chunk for a COLLIDING entity_id', async () => {
    const projA = await projectService.create('Project A');
    const projB = await projectService.create('Project B');
    const mainA = await mainBranchOf(projA.id);
    const mainB = await mainBranchOf(projB.id);
    expect(mainA).not.toBe(mainB);

    const llm = new MockLlm();
    const indexer = new IndexerService(db, llm);
    const rag = new RagService(db, llm);

    // SAME entity_id 'foo' in BOTH projects. SAME topic word 'foo' as the first
    // word of both contents ⇒ BOTH chunks embed to the SAME one-hot vector, so a
    // query for 'foo' ties them at distance 0. The chunk TEXT differs, so we can
    // tell which project's chunk was retrieved.
    //
    // The head join is `he.entity_id = dc.entity_id AND he.branch_id = mainA`.
    // Because entity_id collides ('foo'), B's doc_chunk would JOIN against A's
    // head row for 'foo'. With the distance tie, WITHOUT the doc_chunks.project_id
    // predicate B's chunk could be returned for an A query (and its TEXT would
    // leak into A's answer). WITH the predicate, only A's chunk (project_id=A) is
    // eligible, so A's answer contains A's text and NEVER B's. This is the exact
    // cross-project leak the predicate must close.
    const aText = 'foo alpha content belonging to project A';
    const bText = 'foo zulu content belonging to project B';
    await commits.commit(
      mainA,
      {
        entities: [
          {
            op: 'add',
            entity: makeEntity({
              entityId: 'foo',
              code: 'A-FOO',
              shortTitle: 'Alpha foo',
              contentMarkdown: aText,
            }),
          },
        ],
        relations: [],
      },
      'A seeds foo',
    );
    await commits.commit(
      mainB,
      {
        entities: [
          {
            op: 'add',
            entity: makeEntity({
              entityId: 'foo',
              code: 'B-FOO',
              shortTitle: 'Beta foo',
              contentMarkdown: bText,
            }),
          },
        ],
        relations: [],
      },
      'B seeds foo',
    );

    // Index BOTH projects' jobs.
    await indexer.runPending();

    // Query A for 'foo': the retrieved chunk TEXT must be A's, never B's — even
    // though both chunks share entity_id 'foo' and tie on distance.
    const answerA = await rag.query(mainA, 'foo question');
    expect(answerA.citations.length).toBeGreaterThanOrEqual(1);
    expect(answerA.citations.every((c) => c.entityId === 'foo')).toBe(true);
    expect(answerA.citations[0].code).toBe('A-FOO');
    expect(answerA.answer).toContain(aText);
    // Hard isolation: B's chunk text NEVER appears in A's answer.
    expect(answerA.answer).not.toContain(bText);

    // Symmetrically, query B returns only B's chunk text.
    const answerB = await rag.query(mainB, 'foo question');
    expect(answerB.citations[0].code).toBe('B-FOO');
    expect(answerB.answer).toContain(bText);
    expect(answerB.answer).not.toContain(aText);
  });

  it('every doc_chunk written by the indexer carries the branch project_id', async () => {
    const projA = await projectService.create('Project A');
    const mainA = await mainBranchOf(projA.id);

    const llm = new MockLlm();
    const indexer = new IndexerService(db, llm);

    await commits.commit(
      mainA,
      {
        entities: [
          {
            op: 'add',
            entity: makeEntity({
              entityId: 'bar',
              contentMarkdown: 'bar some indexable content here',
            }),
          },
        ],
        relations: [],
      },
      'A seeds bar',
    );
    await indexer.runPending();

    const { sql } = await import('drizzle-orm');
    const rows = await db.execute<{ project_id: string | null; n: string }>(
      sql`SELECT project_id, count(*)::text AS n FROM doc_chunks GROUP BY project_id`,
    );
    // Exactly one project_id group, equal to project A's id; none NULL.
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].project_id).toBe(projA.id);
  });
});
