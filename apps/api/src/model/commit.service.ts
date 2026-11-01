// Commit engine for the versioned graph store.
//
// Invariants enforced here (see design §5.2/5.3 + Global Constraints):
//  - Commits are immutable: a change is ALWAYS new *_version rows + a new
//    commit row, never an update to an existing commit.
//  - entity_id / relation_id are stable identities across versions.
//  - head_entities / head_relations are the per-branch MATERIALIZED head-state;
//    the DB does not maintain them. This engine keeps them in exact sync so
//    that fold semantics hold: head-state reflects the LATEST op per id in
//    commit order. add/update -> UPSERT the head row; delete -> DELETE it.
//    Therefore delete-then-add resurrects (upsert re-creates the row) and
//    add-then-delete removes it.
//  - author defaults to 'local'.
//  - ATOMICITY: every write that belongs to one commit (commit row, version
//    rows, head-table upserts/deletes, branch head advance, embedding jobs)
//    happens inside a SINGLE db.transaction(...). Either the whole commit lands
//    or none of it does; a reader can never observe a half-applied commit.

import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Entity, Relation, VersionOp } from '@archi-graph/shared';
import type { Db } from '../db/client';
import {
  DEMO_PROJECT_ID,
  branches,
  commits,
  embeddingJobs,
  entityVersions,
  headEntities,
  headRelations,
  relationVersions,
} from '../db/schema';

export interface EntityChange {
  op: VersionOp;
  entity: Entity;
}

export interface RelationChange {
  op: VersionOp;
  relation: Relation;
}

export interface CommitChanges {
  entities: EntityChange[];
  relations: RelationChange[];
}

export interface CommitResult {
  commitId: string;
}

const DEFAULT_AUTHOR = 'local';

/**
 * Thrown by the commit engine when a write targets a branch that does not
 * exist. Callers (e.g. the HTTP controller) match on the type to map it to a
 * clean 404 instead of a 500 or a brittle message string-match.
 */
export class BranchNotFoundError extends Error {
  constructor(public readonly branchId: string) {
    super(`branch not found: ${branchId}`);
    this.name = 'BranchNotFoundError';
  }
}

/**
 * Returns true iff a branch with the given id exists. Read-only; used by
 * delete paths to distinguish "branch does not exist" from
 * "entity/relation not present in head-state".
 */
export async function branchExists(db: Db, branchId: string): Promise<boolean> {
  const rows = await db
    .select({ id: branches.id })
    .from(branches)
    .where(eq(branches.id, branchId));
  return rows.length > 0;
}

/**
 * Ensures a `main` branch exists FOR THE GIVEN PROJECT. If absent, creates it
 * with an empty initial commit (no version rows, no head-state), stamps the new
 * branch row with `projectId` EXPLICITLY (never relying on any column DEFAULT),
 * and points the branch head at the initial commit. Returns the branch id.
 * Idempotent per project: two distinct projects get two distinct `main`
 * branches (distinct project_id); calling twice for the same project returns
 * the same branch id.
 *
 * Why explicit project_id (carried ruling from the Task 1 review): migration
 * 0001 gave branches.project_id a column DEFAULT of the demo project so v1
 * inserters kept working — a cross-project contamination risk (any inserter
 * that forgets project_id silently scopes to demo). Task 2 makes every
 * branch-creation path pass project_id explicitly (this function +
 * createCandidate), then migration 0002 DROPS that default so a missing
 * project_id now fails loudly instead of silently scoping to demo.
 */
export async function ensureProjectMain(
  db: Db,
  projectId: string,
): Promise<string> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(branches)
      .where(
        and(eq(branches.name, 'main'), eq(branches.projectId, projectId)),
      );
    if (existing.length > 0) {
      return existing[0].id;
    }

    const [branch] = await tx
      .insert(branches)
      // project_id passed EXPLICITLY — do not rely on the column default.
      .values({ name: 'main', projectId, author: DEFAULT_AUTHOR })
      .returning({ id: branches.id });

    // Empty initial commit — establishes a parent for the first real commit.
    const [initial] = await tx
      .insert(commits)
      .values({
        branchId: branch.id,
        parentCommitId: null,
        message: 'initial commit',
        author: DEFAULT_AUTHOR,
      })
      .returning({ id: commits.id });

    await tx
      .update(branches)
      .set({ headCommitId: initial.id })
      .where(eq(branches.id, branch.id));

    return branch.id;
  });
}

/**
 * Ensures the DEMO project's `main` branch exists. Thin wrapper over
 * `ensureProjectMain(db, DEMO_PROJECT_ID)` so existing v1 callers (bootstrap,
 * seeds, poc-import) keep working unchanged. New code should call
 * `ensureProjectMain(db, projectId)` with an explicit project id.
 */
export async function ensureMainBranch(db: Db): Promise<string> {
  return ensureProjectMain(db, DEMO_PROJECT_ID);
}

@Injectable()
export class CommitService {
  constructor(private readonly db: Db) {}

  /**
   * Applies a set of entity/relation changes as ONE immutable commit.
   * All writes happen in a single transaction (atomicity). Returns the new
   * commit id.
   */
  async commit(
    branchId: string,
    changes: CommitChanges,
    message: string,
    author: string = DEFAULT_AUTHOR,
  ): Promise<CommitResult> {
    return this.db.transaction(async (tx) => {
      // 1. Current branch head becomes the new commit's parent.
      const branchRows = await tx
        .select()
        .from(branches)
        .where(eq(branches.id, branchId));
      if (branchRows.length === 0) {
        throw new BranchNotFoundError(branchId);
      }
      const parentCommitId = branchRows[0].headCommitId ?? null;

      // 2. Insert the (immutable) commit row.
      const [commitRow] = await tx
        .insert(commits)
        .values({
          branchId,
          parentCommitId,
          message,
          author,
        })
        .returning({ id: commits.id });
      const commitId = commitRow.id;

      // 3. Entity version rows + head-table maintenance + embedding jobs.
      for (const { op, entity } of changes.entities) {
        await tx.insert(entityVersions).values({
          entityId: entity.entityId,
          commitId,
          op,
          type: entity.type,
          code: entity.code,
          shortTitle: entity.shortTitle,
          group: entity.group,
          tier: entity.tier,
          title: entity.title,
          metadataJson: entity.metadata,
          contentMarkdown: entity.contentMarkdown,
          flowJson: entity.flow ?? null,
          linksJson: entity.links,
          author,
        });

        if (op === 'delete') {
          await tx
            .delete(headEntities)
            .where(
              and(
                eq(headEntities.branchId, branchId),
                eq(headEntities.entityId, entity.entityId),
              ),
            );
        } else {
          // add | update -> UPSERT the materialized head row.
          const headPayload = {
            branchId,
            entityId: entity.entityId,
            commitId,
            type: entity.type,
            code: entity.code,
            shortTitle: entity.shortTitle,
            group: entity.group,
            tier: entity.tier,
            title: entity.title,
            metadataJson: entity.metadata,
            contentMarkdown: entity.contentMarkdown,
            flowJson: entity.flow ?? null,
            linksJson: entity.links,
            author,
          };
          await tx
            .insert(headEntities)
            .values(headPayload)
            .onConflictDoUpdate({
              target: [headEntities.branchId, headEntities.entityId],
              set: {
                commitId,
                type: headPayload.type,
                code: headPayload.code,
                shortTitle: headPayload.shortTitle,
                group: headPayload.group,
                tier: headPayload.tier,
                title: headPayload.title,
                metadataJson: headPayload.metadataJson,
                contentMarkdown: headPayload.contentMarkdown,
                flowJson: headPayload.flowJson,
                linksJson: headPayload.linksJson,
                author,
              },
            });

          // Enqueue an embedding job when content exists and changed (add/update).
          if (entity.contentMarkdown.trim().length > 0) {
            await tx.insert(embeddingJobs).values({
              entityId: entity.entityId,
              commitId,
              status: 'pending',
            });
          }
        }
      }

      // 4. Relation version rows + head-table maintenance.
      for (const { op, relation } of changes.relations) {
        await tx.insert(relationVersions).values({
          relationId: relation.relationId,
          commitId,
          op,
          sourceEntityId: relation.sourceEntityId,
          targetEntityId: relation.targetEntityId,
          kind: relation.kind,
          label: relation.label,
          author,
        });

        if (op === 'delete') {
          await tx
            .delete(headRelations)
            .where(
              and(
                eq(headRelations.branchId, branchId),
                eq(headRelations.relationId, relation.relationId),
              ),
            );
        } else {
          const relPayload = {
            branchId,
            relationId: relation.relationId,
            commitId,
            sourceEntityId: relation.sourceEntityId,
            targetEntityId: relation.targetEntityId,
            kind: relation.kind,
            label: relation.label,
            author,
          };
          await tx
            .insert(headRelations)
            .values(relPayload)
            .onConflictDoUpdate({
              target: [headRelations.branchId, headRelations.relationId],
              set: {
                commitId,
                sourceEntityId: relPayload.sourceEntityId,
                targetEntityId: relPayload.targetEntityId,
                kind: relPayload.kind,
                label: relPayload.label,
                author,
              },
            });
        }
      }

      // 5. Advance the branch head to the new commit.
      await tx
        .update(branches)
        .set({ headCommitId: commitId })
        .where(eq(branches.id, branchId));

      return { commitId };
    });
  }
}
