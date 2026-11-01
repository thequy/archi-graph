// Drizzle schema for the Archi-Graph versioned-graph store.
// Mirrors design §5.2/5.3. Versioning invariants:
//  - entity_id / relation_id are stable identities across versions
//  - commits are immutable; every change is a new *_version row with op ∈ {add,update,delete}
//  - head_entities / head_relations are the per-branch materialized head-state
//  - every versioned table carries author TEXT NOT NULL DEFAULT 'local'
//  - embeddings are fixed 768-dim (doc_chunks.embedding = vector(768))

import { sql } from 'drizzle-orm';
import {
  bigint,
  customType,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * pgvector column type. Drizzle core has no native vector type, so we define a
 * custom type that emits `vector(768)` in DDL.
 */
export const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector(768)';
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
});

/**
 * Stable id of the default "CorpDigi" project the backfill migration creates.
 * v1 had no concept of a project — every branch/doc_chunk/embedding_job hung
 * off a single global `main`. The projects-extension migration adopts all that
 * pre-existing data into this one deterministic project row, and uses this id
 * as the DEFAULT for `branches.project_id` so v1 branch inserters (which do not
 * yet pass a project_id) keep working after the column becomes NOT NULL.
 */
export const DEMO_PROJECT_ID = '11111111-1111-1111-1111-111111111111';
/** Name of the default project the backfill creates. */
export const DEMO_PROJECT_NAME = 'CorpDigi';

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const branches = pgTable('branches', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  // project scope. NOT NULL + FK -> projects.id. The column DEFAULT (the demo
  // project) that migration 0001 added as a transitional safety net is DROPPED
  // by migration 0002 (carried ruling from the Task 1 review): every
  // branch-creation path now passes project_id EXPLICITLY (ensureProjectMain,
  // createCandidate), so a missing project_id must fail loudly rather than
  // silently scope to the demo project. No `.default(...)` here, to match the
  // post-0002 DDL.
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id),
  headCommitId: uuid('head_commit_id'),
  parentCommitId: uuid('parent_commit_id'),
  author: text('author').notNull().default('local'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const commits = pgTable('commits', {
  id: uuid('id').primaryKey().defaultRandom(),
  branchId: uuid('branch_id')
    .notNull()
    .references(() => branches.id),
  parentCommitId: uuid('parent_commit_id'),
  message: text('message').notNull(),
  author: text('author').notNull().default('local'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const entityVersions = pgTable('entity_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityId: text('entity_id').notNull(),
  commitId: uuid('commit_id')
    .notNull()
    .references(() => commits.id),
  op: text('op').notNull(),
  type: text('type').notNull(),
  code: text('code').notNull(),
  shortTitle: text('short_title').notNull(),
  group: text('group').notNull(),
  tier: text('tier').notNull(),
  title: text('title').notNull(),
  metadataJson: jsonb('metadata_json').notNull(),
  contentMarkdown: text('content_markdown').notNull(),
  flowJson: jsonb('flow_json'),
  linksJson: jsonb('links_json').notNull(),
  diagramsJson: jsonb('diagrams_json'),
  appliesPatternsJson: jsonb('applies_patterns_json'),
  author: text('author').notNull().default('local'),
});

export const relationVersions = pgTable('relation_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  relationId: text('relation_id').notNull(),
  commitId: uuid('commit_id')
    .notNull()
    .references(() => commits.id),
  op: text('op').notNull(),
  sourceEntityId: text('source_entity_id').notNull(),
  targetEntityId: text('target_entity_id').notNull(),
  kind: text('kind').notNull(),
  label: text('label').notNull(),
  author: text('author').notNull().default('local'),
});

export const headEntities = pgTable(
  'head_entities',
  {
    branchId: uuid('branch_id').notNull(),
    entityId: text('entity_id').notNull(),
    commitId: uuid('commit_id').notNull(),
    type: text('type').notNull(),
    code: text('code').notNull(),
    shortTitle: text('short_title').notNull(),
    group: text('group').notNull(),
    tier: text('tier').notNull(),
    title: text('title').notNull(),
    metadataJson: jsonb('metadata_json').notNull(),
    contentMarkdown: text('content_markdown').notNull(),
    flowJson: jsonb('flow_json'),
    linksJson: jsonb('links_json').notNull(),
    diagramsJson: jsonb('diagrams_json'),
    appliesPatternsJson: jsonb('applies_patterns_json'),
    author: text('author').notNull().default('local'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.branchId, t.entityId] }),
  }),
);

export const headRelations = pgTable(
  'head_relations',
  {
    branchId: uuid('branch_id').notNull(),
    relationId: text('relation_id').notNull(),
    commitId: uuid('commit_id').notNull(),
    sourceEntityId: text('source_entity_id').notNull(),
    targetEntityId: text('target_entity_id').notNull(),
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    author: text('author').notNull().default('local'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.branchId, t.relationId] }),
  }),
);

export const docChunks = pgTable(
  'doc_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: text('entity_id').notNull(),
    commitId: uuid('commit_id').notNull(),
    // project scope (nullable: backfilled to the demo project for v1 rows,
    // populated explicitly by later upload/indexing paths).
    projectId: uuid('project_id'),
    chunkIndex: integer('chunk_index').notNull(),
    text: text('text').notNull(),
    embedding: vector('embedding'),
  },
  (t) => ({
    uq: unique('doc_chunks_entity_commit_chunk_uq').on(
      t.entityId,
      t.commitId,
      t.chunkIndex,
    ),
  }),
);

export const embeddingJobs = pgTable('embedding_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityId: text('entity_id').notNull(),
  commitId: uuid('commit_id').notNull(),
  // project scope (nullable: backfilled to the demo project for v1 rows).
  projectId: uuid('project_id'),
  status: text('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Uploaded source documents (Slice C — Upload). A file belongs to exactly one
 * project (project_id FK -> projects.id). The blob itself lives on the local
 * filesystem under DATA_DIR (no S3 — 1 user, local-first); `storage_path` is
 * the absolute path returned by the blob store.
 *
 * Upload is deliberately cheap: POST stores the blob + inserts a row with
 * `summary_status = 'pending'` and returns promptly. Task 8's ingest pipeline
 * later extracts text (populating `extracted_chars`), produces an LLM summary,
 * links the derived entity (`entity_id`), and advances `summary_status`.
 */
export const files = pgTable('files', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id),
  // Filled in later by the ingest pipeline (Task 8) once an entity is derived
  // from the file; null until then. Plain text id (matches entity_id elsewhere).
  entityId: text('entity_id'),
  filename: text('filename').notNull(),
  mime: text('mime').notNull(),
  // Size can exceed 2^31; bigint. Returned as a JS number via mode: 'number'.
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  storagePath: text('storage_path').notNull(),
  extractedChars: integer('extracted_chars'),
  summaryStatus: text('summary_status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Global pattern catalog (Slice D — Pattern Wiki).
 *
 * Patterns are GLOBAL (no project_id) and NOT versioned — a plain CRUD table.
 * An entity "applies" a pattern by storing the pattern `slug` in its
 * head_entities.applies_patterns_json array (Task 10); the reverse "used-by"
 * lookup scans those arrays. `slug` is the stable, human-readable key used by
 * both the CRUD surface (`/patterns/:slug`) and the applies-patterns link, so
 * it carries a UNIQUE constraint. `category` is 'gof' | 'system-design'. The
 * `mermaid` concept diagram and `kind` are optional (nullable).
 */
export const patterns = pgTable('patterns', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  category: text('category').notNull(),
  intent: text('intent').notNull(),
  whenToUse: text('when_to_use').notNull(),
  pros: text('pros').notNull(),
  cons: text('cons').notNull(),
  mermaid: text('mermaid'),
  kind: text('kind'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Statement that must run before tables (pgvector type registration). */
export const CREATE_VECTOR_EXTENSION = sql`CREATE EXTENSION IF NOT EXISTS vector;`;

export const schema = {
  projects,
  branches,
  commits,
  entityVersions,
  relationVersions,
  headEntities,
  headRelations,
  docChunks,
  embeddingJobs,
  files,
  patterns,
};
