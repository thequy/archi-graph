// Drizzle schema for the Archi-Graph versioned-graph store.
// Mirrors design §5.2/5.3. Versioning invariants:
//  - entity_id / relation_id are stable identities across versions
//  - commits are immutable; every change is a new *_version row with op ∈ {add,update,delete}
//  - head_entities / head_relations are the per-branch materialized head-state
//  - every versioned table carries author TEXT NOT NULL DEFAULT 'local'
//  - embeddings are fixed 768-dim (doc_chunks.embedding = vector(768))

import { sql } from 'drizzle-orm';
import {
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
};
