// Branch service: creating candidate branches off an existing branch.
//
// A candidate branch is a COPY-ON-CREATE fork of the parent's head-state:
//   - We read the parent's materialized head-state rows (head_entities /
//     head_relations keyed by the parent branch_id) and INSERT copies keyed by
//     the NEW branch_id, inside ONE transaction. This is the correct mechanism
//     given the schema: head tables are independent per branch_id (Global
//     Constraint), so copying the rows gives the candidate its own fully
//     isolated head-state. After creation, commits on either branch only touch
//     their own branch_id rows — parent and candidate never affect each other.
//   - parent_commit_id is pinned to the parent's current head_commit_id so the
//     candidate records exactly which immutable commit it forked from. The
//     candidate's own head_commit_id starts at that same pinned commit (no new
//     commit row is created for the fork — the fork is a pointer + a head-state
//     snapshot, not a commit).
//
// Rationale for not creating a fresh commit: commits are immutable and belong
// to a single branch's history; the fork shares the parent's commit as its
// starting point (parent_commit_id) and diverges only when real commits land
// on the candidate. Copying head rows (rather than re-folding every commit)
// keeps creation O(head size) and reuses the already-materialized state.

import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { branches, headEntities, headRelations } from '../db/schema';
import { BranchNotFoundError } from '../model/commit.service';

export interface CreateCandidateResult {
  branchId: string;
}

export interface BranchSummary {
  id: string;
  name: string;
  headCommitId: string | null;
  parentCommitId: string | null;
  author: string;
  createdAt: Date;
}

@Injectable()
export class BranchService {
  constructor(private readonly db: Db) {}

  /**
   * Creates a candidate branch whose head-state is a copy of `fromBranchId`'s
   * head-state at creation. All work happens in one transaction so the new
   * branch row and its copied head rows land atomically.
   *
   * @throws BranchNotFoundError if `fromBranchId` does not exist.
   */
  async createCandidate(
    name: string,
    fromBranchId: string,
  ): Promise<CreateCandidateResult> {
    return this.db.transaction(async (tx) => {
      const parentRows = await tx
        .select()
        .from(branches)
        .where(eq(branches.id, fromBranchId));
      if (parentRows.length === 0) {
        throw new BranchNotFoundError(fromBranchId);
      }
      const parent = parentRows[0];
      // Pin the fork point to the parent's current head commit.
      const pinnedCommitId = parent.headCommitId ?? null;

      const [created] = await tx
        .insert(branches)
        .values({
          name,
          // Inherit the parent's project scope EXPLICITLY (carried ruling): a
          // candidate lives in the SAME project as the branch it forks from.
          // We read parent.projectId and pass it on insert rather than relying
          // on the column default (which is dropped in a later migration), so a
          // fork can never silently land in the demo project.
          projectId: parent.projectId,
          headCommitId: pinnedCommitId,
          parentCommitId: pinnedCommitId,
          author: parent.author,
        })
        .returning({ id: branches.id });
      const newBranchId = created.id;

      // Snapshot the parent's materialized head-state into the new branch_id.
      const parentEntities = await tx
        .select()
        .from(headEntities)
        .where(eq(headEntities.branchId, fromBranchId));
      if (parentEntities.length > 0) {
        await tx.insert(headEntities).values(
          parentEntities.map((row) => ({
            branchId: newBranchId,
            entityId: row.entityId,
            commitId: row.commitId,
            type: row.type,
            code: row.code,
            shortTitle: row.shortTitle,
            group: row.group,
            tier: row.tier,
            title: row.title,
            metadataJson: row.metadataJson,
            contentMarkdown: row.contentMarkdown,
            flowJson: row.flowJson,
            linksJson: row.linksJson,
            diagramsJson: row.diagramsJson,
            author: row.author,
          })),
        );
      }

      const parentRelations = await tx
        .select()
        .from(headRelations)
        .where(eq(headRelations.branchId, fromBranchId));
      if (parentRelations.length > 0) {
        await tx.insert(headRelations).values(
          parentRelations.map((row) => ({
            branchId: newBranchId,
            relationId: row.relationId,
            commitId: row.commitId,
            sourceEntityId: row.sourceEntityId,
            targetEntityId: row.targetEntityId,
            kind: row.kind,
            label: row.label,
            author: row.author,
          })),
        );
      }

      return { branchId: newBranchId };
    });
  }

  /**
   * Lists branch summary rows. When `projectId` is given, returns ONLY the
   * branches of that project (the project-scoped, isolated listing the HTTP
   * surface uses when a `?projectId=` is supplied). When omitted, returns ALL
   * branches — the backward-compatible v1 behavior.
   */
  async listBranches(projectId?: string): Promise<BranchSummary[]> {
    const base = this.db.select().from(branches);
    const rows = projectId
      ? await base.where(eq(branches.projectId, projectId))
      : await base;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      headCommitId: row.headCommitId,
      parentCommitId: row.parentCommitId,
      author: row.author,
      createdAt: row.createdAt,
    }));
  }
}
