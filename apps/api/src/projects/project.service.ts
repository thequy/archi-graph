// Projects module — the top-level scope CRUD + per-project `main` branch.
//
// A project is the top-level container: every branch (and its versioned graph
// data) belongs to exactly one project via branches.project_id. There is no
// owner (1 user, local-first, no auth — Global Constraint).
//
// create() does two things atomically-ish: inserts the project row, then calls
// ensureProjectMain(projectId) so a freshly created project ALWAYS has its own
// isolated `main` branch (tagged with that project's id — never the demo
// project). Two projects therefore get two DISTINCT main branches.
//
// remove() CASCADE-deletes the project's branches and all their versioned-graph
// data (commits, *_version rows, head-state, embedding jobs, doc chunks) in one
// transaction, then deletes the project row. We cascade (rather than block) so
// deleting a project is a single intuitive operation for the local-first single
// user; everything scoped to the project goes with it. The deletes run in FK
// dependency order (child rows before the commits/branches they reference) so
// the branches_* / commits_* foreign keys never block the delete.

import { Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  branches,
  commits,
  docChunks,
  embeddingJobs,
  entityVersions,
  headEntities,
  headRelations,
  projects,
  relationVersions,
} from '../db/schema';
import { ensureProjectMain } from '../model/commit.service';

export interface Project {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
}

@Injectable()
export class ProjectService {
  constructor(private readonly db: Db) {}

  /**
   * Creates a project and its own `main` branch (empty initial commit). The
   * main branch is stamped with the new project's id EXPLICITLY via
   * ensureProjectMain — never the demo project. Returns the project row.
   */
  async create(name: string, description?: string): Promise<Project> {
    const [row] = await this.db
      .insert(projects)
      .values({ name, description: description ?? null })
      .returning();
    // Give the project its own isolated main branch (idempotent per project).
    await ensureProjectMain(this.db, row.id);
    return this.toProject(row);
  }

  /** Lists all projects, newest first. */
  async list(): Promise<Project[]> {
    const rows = await this.db.select().from(projects);
    return rows
      .map((r) => this.toProject(r))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /** Returns the project by id, or null if it does not exist. */
  async get(id: string): Promise<Project | null> {
    const rows = await this.db
      .select()
      .from(projects)
      .where(eq(projects.id, id));
    return rows.length > 0 ? this.toProject(rows[0]) : null;
  }

  /** Renames a project. Returns the updated row, or null if not found. */
  async rename(id: string, name: string): Promise<Project | null> {
    const rows = await this.db
      .update(projects)
      .set({ name })
      .where(eq(projects.id, id))
      .returning();
    return rows.length > 0 ? this.toProject(rows[0]) : null;
  }

  /**
   * Deletes a project and CASCADE-deletes all its branches + their versioned
   * data in one transaction. Returns true if a project was deleted, false if
   * the id did not exist.
   */
  async remove(id: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const projectRows = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, id));
      if (projectRows.length === 0) {
        return false;
      }

      // All branches scoped to this project.
      const projectBranches = await tx
        .select({ id: branches.id })
        .from(branches)
        .where(eq(branches.projectId, id));
      const branchIds = projectBranches.map((b) => b.id);

      if (branchIds.length > 0) {
        // All commits on those branches (parents of the *_version rows).
        const branchCommits = await tx
          .select({ id: commits.id })
          .from(commits)
          .where(inArray(commits.branchId, branchIds));
        const commitIds = branchCommits.map((c) => c.id);

        // Child rows first (FK dependency order), then commits, then branches.
        if (commitIds.length > 0) {
          await tx
            .delete(entityVersions)
            .where(inArray(entityVersions.commitId, commitIds));
          await tx
            .delete(relationVersions)
            .where(inArray(relationVersions.commitId, commitIds));
          await tx
            .delete(docChunks)
            .where(inArray(docChunks.commitId, commitIds));
          await tx
            .delete(embeddingJobs)
            .where(inArray(embeddingJobs.commitId, commitIds));
        }

        // Per-branch materialized head-state (keyed by branch_id, no FK).
        await tx
          .delete(headEntities)
          .where(inArray(headEntities.branchId, branchIds));
        await tx
          .delete(headRelations)
          .where(inArray(headRelations.branchId, branchIds));

        // Break the branches.head_commit_id -> commits self-reference before
        // deleting commits, so the commits delete cannot be blocked by it.
        await tx
          .update(branches)
          .set({ headCommitId: null })
          .where(inArray(branches.id, branchIds));

        await tx.delete(commits).where(inArray(commits.branchId, branchIds));
        await tx.delete(branches).where(inArray(branches.id, branchIds));
      }

      await tx.delete(projects).where(eq(projects.id, id));
      return true;
    });
  }

  private toProject(row: typeof projects.$inferSelect): Project {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      createdAt: row.createdAt,
    };
  }
}
