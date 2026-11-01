// Three-way merge of a candidate branch back into the branch it forked from.
//
// ─────────────────────────────────────────────────────────────────────────────
// MERGE BASE (common ancestor)
// ─────────────────────────────────────────────────────────────────────────────
// createCandidate does NOT create a commit: it copies the parent's head-state
// rows into the new branch_id and PINS the candidate's parent_commit_id to the
// parent's head_commit_id at fork time. So the common ancestor for a three-way
// merge is the PARENT branch's head-state AT that pinned commit.
//
// The head_* tables only hold the CURRENT head-state per branch, not history,
// so we cannot read the base out of them directly. We reconstruct it by FOLDING
// the per-commit deltas: foldStateAtCommit(db, commitId) walks the
// commit.parent_commit_id ancestry from `commitId` back to the root, orders the
// commits oldest→newest, and replays the entity_versions / relation_versions
// ops (add|update => upsert, delete => remove) to materialize the HeadState as
// it existed at that commit. (The parent branch's CURRENT head equals folding
// at its head_commit_id — verified in tests — so this is a faithful base.)
//
// We walk parent_commit_id irrespective of branch_id: the ancestry chain up to
// the candidate's fork point lives entirely on the parent branch for v1, and
// following the explicit parent pointer is correct regardless.
//
// ─────────────────────────────────────────────────────────────────────────────
// CONFLICT TAXONOMY (whole-entity / whole-relation granularity)
// ─────────────────────────────────────────────────────────────────────────────
// For each entity id and relation id we compute, relative to the base:
//   ours   = how the MAIN / base branch changed it (base-side)
//   theirs = how the CANDIDATE changed it
// where "changed" means added, updated (payload differs), or deleted vs base.
//
//   - changed on ONE side only            → auto-take that side.
//   - changed on BOTH sides, same result  → no conflict (both agree).
//   - changed on BOTH sides, DIFFERING    → `entity` / `relation` conflict.
//
// REFERENTIAL conflict: after computing the merged ENTITY set, any relation that
// would land in the merged result but whose source or target entity is absent
// from that merged entity set is a `referential` conflict. This guarantees the
// merge commit NEVER emits an orphan relation (Global Constraint / Review Focus).
// Note head-state may already hold a dangling relation (CRUD delete does not
// cascade), but our merge still refuses to EMIT one.
//
// ─────────────────────────────────────────────────────────────────────────────
// RESULT
// ─────────────────────────────────────────────────────────────────────────────
//   clean    → apply the merged change-set as ONE new commit on the base branch
//              (the branch the candidate forked from) via CommitService.
//   conflict → return the conflicts; apply nothing (no commit).
//   With `resolutions` covering EVERY conflict id (ours|theirs), apply the
//   chosen side per id and commit → clean.

import { eq, inArray } from 'drizzle-orm';
import type {
  Entity,
  HeadState,
  MergeConflict,
  MergeResolutions,
  MergeResult,
  Relation,
} from '@archi-graph/shared';
import type { Db } from '../db/client';
import {
  branches,
  commits,
  entityVersions,
  relationVersions,
} from '../db/schema';
import {
  CommitService,
  type CommitChanges,
  type EntityChange,
  type RelationChange,
} from '../model/commit.service';
import { foldHeadState } from '../model/fold';
import { entityEquals, relationEquals } from './equality';

// Canonical merge contract lives in @archi-graph/shared. Re-exported here so
// existing importers (e.g. versioning.controller.ts) keep working unchanged.
export type { MergeConflict, MergeResult } from '@archi-graph/shared';

export interface MergeOptions {
  resolutions?: MergeResolutions;
}

// ─── Base reconstruction ────────────────────────────────────────────────────

type EntityVersionRow = typeof entityVersions.$inferSelect;
type RelationVersionRow = typeof relationVersions.$inferSelect;

function entityVersionToEntity(row: EntityVersionRow): Entity {
  return {
    entityId: row.entityId,
    type: row.type as Entity['type'],
    code: row.code,
    shortTitle: row.shortTitle,
    group: row.group as Entity['group'],
    tier: row.tier as Entity['tier'],
    title: row.title,
    metadata: row.metadataJson as Entity['metadata'],
    contentMarkdown: row.contentMarkdown,
    flow: row.flowJson ?? null,
    links: (row.linksJson as Entity['links']) ?? [],
    diagrams: (row.diagramsJson as Entity['diagrams']) ?? undefined,
    appliesPatterns: (row.appliesPatternsJson as Entity['appliesPatterns']) ?? undefined,
  };
}

function relationVersionToRelation(row: RelationVersionRow): Relation {
  return {
    relationId: row.relationId,
    sourceEntityId: row.sourceEntityId,
    targetEntityId: row.targetEntityId,
    kind: row.kind as Relation['kind'],
    label: row.label,
  };
}

/**
 * Reconstructs the HeadState as it existed at `commitId` by replaying the
 * per-commit version deltas along the commit ancestry (oldest→newest).
 *
 * Walks commit.parent_commit_id from `commitId` back to the root to establish
 * commit order, then applies each commit's entity/relation ops:
 *   add | update → upsert (latest-op-wins)
 *   delete       → remove
 */
export async function foldStateAtCommit(
  db: Db,
  commitId: string | null,
): Promise<HeadState> {
  if (!commitId) {
    return { entities: [], relations: [] };
  }

  // 1. Walk the ancestry (newest→oldest), then reverse to oldest→newest.
  const chain: string[] = [];
  let current: string | null = commitId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    const rows: { parentCommitId: string | null }[] = await db
      .select({ parentCommitId: commits.parentCommitId })
      .from(commits)
      .where(eq(commits.id, current));
    current = rows.length > 0 ? rows[0].parentCommitId : null;
  }
  chain.reverse();

  if (chain.length === 0) {
    return { entities: [], relations: [] };
  }

  // 2. Fetch all version rows for the commits in the chain.
  const [eRows, rRows] = await Promise.all([
    db.select().from(entityVersions).where(inArray(entityVersions.commitId, chain)),
    db
      .select()
      .from(relationVersions)
      .where(inArray(relationVersions.commitId, chain)),
  ]);

  // 3. Group rows by commit so we can replay in commit order. A single commit
  //    carries at most one op per id (the commit engine writes one row per
  //    change), so grouping is enough; order within a commit is irrelevant.
  const entityByCommit = new Map<string, EntityVersionRow[]>();
  for (const row of eRows) {
    const list = entityByCommit.get(row.commitId) ?? [];
    list.push(row);
    entityByCommit.set(row.commitId, list);
  }
  const relationByCommit = new Map<string, RelationVersionRow[]>();
  for (const row of rRows) {
    const list = relationByCommit.get(row.commitId) ?? [];
    list.push(row);
    relationByCommit.set(row.commitId, list);
  }

  const entities = new Map<string, Entity>();
  const relations = new Map<string, Relation>();

  for (const cid of chain) {
    for (const row of entityByCommit.get(cid) ?? []) {
      if (row.op === 'delete') {
        entities.delete(row.entityId);
      } else {
        entities.set(row.entityId, entityVersionToEntity(row));
      }
    }
    for (const row of relationByCommit.get(cid) ?? []) {
      if (row.op === 'delete') {
        relations.delete(row.relationId);
      } else {
        relations.set(row.relationId, relationVersionToRelation(row));
      }
    }
  }

  return {
    entities: [...entities.values()],
    relations: [...relations.values()],
  };
}

// ─── Three-way change classification ─────────────────────────────────────────

type Side = 'ours' | 'theirs';

/**
 * Per-id three-way outcome for one collection (entities or relations).
 * `value` is the chosen merged value or null when the merge removes the id.
 */
interface Merged<T> {
  /** ids whose merged result differs from base (what we must commit). */
  changes: { id: string; value: T | null; takenFrom: Side | 'both' }[];
  /** unresolved true conflicts. */
  conflicts: MergeConflict[];
  /** final merged map (id -> value) including untouched base entries. */
  finalMap: Map<string, T>;
  /** ids that are GENUINELY removed in the merged result (a delete won). */
  deletedIds: Set<string>;
  /** ids that are unresolved conflicts (merge is blocked; present in base). */
  conflictIds: Set<string>;
}

/**
 * Classifies one id-keyed collection three-way.
 *
 * base/ours/theirs are maps id -> value (absent = not present on that side).
 * `changed(a,b)` decides whether two present values differ.
 * `conflictKind` tags the emitted conflicts ('entity' | 'relation').
 */
function mergeCollection<T>(
  base: Map<string, T>,
  ours: Map<string, T>,
  theirs: Map<string, T>,
  changed: (a: T, b: T) => boolean,
  conflictKind: 'entity' | 'relation',
  resolutions: Record<string, 'ours' | 'theirs'>,
): Merged<T> {
  const ids = new Set<string>([
    ...base.keys(),
    ...ours.keys(),
    ...theirs.keys(),
  ]);

  const changes: Merged<T>['changes'] = [];
  const conflicts: MergeConflict[] = [];
  const finalMap = new Map<string, T>();
  const deletedIds = new Set<string>();
  const conflictIds = new Set<string>();

  for (const id of ids) {
    const b = base.get(id) ?? null;
    const o = ours.get(id) ?? null;
    const t = theirs.get(id) ?? null;

    const ourChanged = !valueEqual(b, o, changed);
    const theirChanged = !valueEqual(b, t, changed);

    if (!ourChanged && !theirChanged) {
      // untouched on both sides — keep base value (if any).
      if (b !== null) finalMap.set(id, b);
      continue;
    }

    if (ourChanged && !theirChanged) {
      if (o !== null) finalMap.set(id, o);
      else deletedIds.add(id);
      changes.push({ id, value: o, takenFrom: 'ours' });
      continue;
    }

    if (!ourChanged && theirChanged) {
      if (t !== null) finalMap.set(id, t);
      else deletedIds.add(id);
      changes.push({ id, value: t, takenFrom: 'theirs' });
      continue;
    }

    // Changed on BOTH sides.
    if (valueEqual(o, t, changed)) {
      // Converged to the same result — not a conflict.
      if (o !== null) finalMap.set(id, o);
      else deletedIds.add(id);
      changes.push({ id, value: o, takenFrom: 'both' });
      continue;
    }

    // True conflict — honor a resolution if present.
    const resolution = resolutions[id];
    if (resolution === 'ours') {
      if (o !== null) finalMap.set(id, o);
      else deletedIds.add(id);
      changes.push({ id, value: o, takenFrom: 'ours' });
    } else if (resolution === 'theirs') {
      if (t !== null) finalMap.set(id, t);
      else deletedIds.add(id);
      changes.push({ id, value: t, takenFrom: 'theirs' });
    } else {
      conflicts.push({ kind: conflictKind, id, base: b, ours: o, theirs: t });
      conflictIds.add(id);
    }
  }

  return { changes, conflicts, finalMap, deletedIds, conflictIds };
}

/** Equality that treats both-null as equal and a single null as "differs". */
function valueEqual<T>(
  a: T | null,
  b: T | null,
  changed: (a: T, b: T) => boolean,
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return !changed(a, b);
}

/**
 * True when `merged` (the chosen merge value, or null for a delete) is a REAL
 * change relative to `ours` (the base-branch head value for that id, or null if
 * absent). Used to trim the clean-merge change-set down to the delta the base
 * branch does not already reflect:
 *   - merged === ours (both present & equal, or both absent) → NOT a delta.
 *   - a delete (merged null) where ours is already absent     → NOT a delta.
 *   - otherwise                                               → real delta.
 */
function isRealDelta<T>(
  merged: T | null,
  ours: T | null,
  changed: (a: T, b: T) => boolean,
): boolean {
  return !valueEqual(merged, ours, changed);
}

function entityChanged(a: Entity, b: Entity): boolean {
  return !entityEquals(a, b);
}

function relationChanged(a: Relation, b: Relation): boolean {
  return !relationEquals(a, b);
}

function toMap<T>(items: T[], idOf: (t: T) => string): Map<string, T> {
  return new Map(items.map((i) => [idOf(i), i]));
}

// ─── Base branch resolution ──────────────────────────────────────────────────

/**
 * Finds the branch the candidate forked from: the pinned parent_commit_id
 * identifies the exact commit at the fork point, and that commit's branch_id
 * IS the base branch. (We cannot match on branches.head_commit_id because the
 * base branch's head advances past the fork point once new commits land on it.)
 * For v1 this resolves to `main`.
 */
async function findBaseBranchId(
  db: Db,
  candidate: { id: string; parentCommitId: string | null },
): Promise<string | null> {
  if (!candidate.parentCommitId) return null;
  const rows = await db
    .select({ branchId: commits.branchId })
    .from(commits)
    .where(eq(commits.id, candidate.parentCommitId));
  const baseBranchId = rows.length > 0 ? rows[0].branchId : null;
  // Guard against (impossible for v1) self-reference.
  if (baseBranchId === candidate.id) return null;
  return baseBranchId;
}

export class MergeError extends Error {}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function mergeCandidate(
  db: Db,
  candidateBranchId: string,
  options: MergeOptions = {},
): Promise<MergeResult> {
  const resolutions = options.resolutions ?? {};

  // Load the candidate branch row.
  const candRows = await db
    .select()
    .from(branches)
    .where(eq(branches.id, candidateBranchId));
  if (candRows.length === 0) {
    throw new MergeError(`candidate branch not found: ${candidateBranchId}`);
  }
  const candidate = candRows[0];

  const baseBranchId = await findBaseBranchId(db, {
    id: candidate.id,
    parentCommitId: candidate.parentCommitId,
  });
  if (!baseBranchId) {
    throw new MergeError(
      `could not resolve base branch for candidate ${candidateBranchId}`,
    );
  }

  // Three sides: base (pinned fork commit), ours (base branch current head),
  // theirs (candidate current head).
  const [base, ours, theirs] = await Promise.all([
    foldStateAtCommit(db, candidate.parentCommitId),
    foldHeadState(db, baseBranchId),
    foldHeadState(db, candidateBranchId),
  ]);

  // Classify entities and relations three-way.
  const mergedEntities = mergeCollection(
    toMap(base.entities, (e) => e.entityId),
    toMap(ours.entities, (e) => e.entityId),
    toMap(theirs.entities, (e) => e.entityId),
    entityChanged,
    'entity',
    resolutions,
  );

  const mergedRelations = mergeCollection(
    toMap(base.relations, (r) => r.relationId),
    toMap(ours.relations, (r) => r.relationId),
    toMap(theirs.relations, (r) => r.relationId),
    relationChanged,
    'relation',
    resolutions,
  );

  const conflicts: MergeConflict[] = [
    ...mergedEntities.conflicts,
    ...mergedRelations.conflicts,
  ];

  // REFERENTIAL check: every relation that would land in the merged result must
  // have BOTH endpoints present in the merged entity set. A relation whose
  // endpoint entity was genuinely DELETED (a delete won) while the relation is
  // present/added on the other side is a `referential` conflict — this is what
  // prevents a merge commit from ever emitting an orphan relation (Global
  // Constraint / Review Focus).
  //
  // "Present in merged result" = every entity id in base or added by the merge,
  // MINUS the ids genuinely deleted. We deliberately do NOT treat an entity
  // that is merely an UNRESOLVED entity-conflict as absent: that conflict
  // already blocks the merge, and its entity still exists in base, so a stable
  // relation pointing at it is not an orphan. Counting it as absent would raise
  // a spurious referential conflict for every relation touching the conflicted
  // entity.
  const mergedEntityIds = new Set<string>();
  for (const id of mergedEntities.finalMap.keys()) mergedEntityIds.add(id);
  for (const id of mergedEntities.conflictIds) mergedEntityIds.add(id);
  for (const id of mergedEntities.deletedIds) mergedEntityIds.delete(id);

  for (const rel of mergedRelations.finalMap.values()) {
    const sourceOk = mergedEntityIds.has(rel.sourceEntityId);
    const targetOk = mergedEntityIds.has(rel.targetEntityId);
    if (!sourceOk || !targetOk) {
      conflicts.push({
        kind: 'referential',
        id: rel.relationId,
        base: base.relations.find((r) => r.relationId === rel.relationId) ?? null,
        ours: ours.relations.find((r) => r.relationId === rel.relationId) ?? null,
        theirs:
          theirs.relations.find((r) => r.relationId === rel.relationId) ?? null,
      });
    }
  }

  if (conflicts.length > 0) {
    return { status: 'conflict', conflicts };
  }

  // Clean — build the commit change-set as the REAL DELTA vs the base-branch
  // head (ours). The merge commit lands ON the base branch, so anything the
  // base branch already reflects must NOT be re-emitted: re-committing it is
  // pure write amplification and (for entities with content) spawns duplicate
  // embedding_jobs. We therefore drop every change whose chosen merged value
  // already equals the ours (base-branch head) value for that id, and only
  // emit a delete when the id actually EXISTS on ours (deleting what ours
  // doesn't have is a no-op). This is purely a change-set trim — conflict and
  // referential behavior above are untouched.
  const oursEntityMap = toMap(ours.entities, (e) => e.entityId);
  const oursRelationMap = toMap(ours.relations, (r) => r.relationId);

  const entityChanges: EntityChange[] = mergedEntities.changes
    .filter((c) => isRealDelta(c.value, oursEntityMap.get(c.id) ?? null, entityChanged))
    .map((c) =>
      c.value === null
        ? { op: 'delete', entity: reconstructDeletedEntity(base, c.id) }
        : { op: 'update', entity: c.value },
    );
  const relationChanges: RelationChange[] = mergedRelations.changes
    .filter((c) =>
      isRealDelta(c.value, oursRelationMap.get(c.id) ?? null, relationChanged),
    )
    .map((c) =>
      c.value === null
        ? { op: 'delete', relation: reconstructDeletedRelation(base, c.id) }
        : { op: 'update', relation: c.value },
    );

  const changes: CommitChanges = {
    entities: entityChanges,
    relations: relationChanges,
  };

  // Nothing actually changed relative to the base-branch head — skip the empty
  // commit but still report clean with the current head commit.
  if (entityChanges.length === 0 && relationChanges.length === 0) {
    return {
      status: 'clean',
      commitId: candidate.parentCommitId ?? '',
    };
  }

  const commitService = new CommitService(db);
  const { commitId } = await commitService.commit(
    baseBranchId,
    changes,
    `merge candidate ${candidateBranchId}`,
  );
  return { status: 'clean', commitId };
}

/**
 * A delete op needs an Entity payload for the version row. We take the base
 * value (the entity as it was at the fork point) since that is the row being
 * removed; `op: 'delete'` makes the engine drop the head row regardless.
 */
function reconstructDeletedEntity(base: HeadState, id: string): Entity {
  const found = base.entities.find((e) => e.entityId === id);
  if (found) return found;
  // Should not happen (a null merged value means it existed in base), but keep
  // a well-formed placeholder for safety.
  return {
    entityId: id,
    type: 'brd',
    code: '',
    shortTitle: '',
    group: 'soe',
    tier: 't0',
    title: '',
    metadata: { author: 'local', date: '', status: '', tags: [] },
    contentMarkdown: '',
    flow: null,
    links: [],
  };
}

function reconstructDeletedRelation(base: HeadState, id: string): Relation {
  const found = base.relations.find((r) => r.relationId === id);
  if (found) return found;
  return {
    relationId: id,
    sourceEntityId: '',
    targetEntityId: '',
    kind: 'hierarchy',
    label: '',
  };
}
