// Graph diff between two branches' head-states.
//
// Semantics (design §5.4 + Global Constraints):
//  - Compare by STABLE identity: entity_id for entities, relation_id for
//    relations. The same id present on both sides with differing payload is an
//    `updated`; present only on the candidate is `added`; present only on the
//    base is `deleted`.
//  - A relation counts as `updated` when its SOURCE endpoint OR its TARGET
//    endpoint OR its label (or kind) changed. This is a Review Focus item: an
//    endpoint repoint must NOT be mistaken for "unchanged" just because the
//    label stayed the same.
//  - An entity counts as `updated` when ANY payload field differs. We compare
//    by a stable deep-equality over the normalized DTO so field additions in
//    the domain type are covered without touching this code.
//
// The diff is computed from the MATERIALIZED head-state via foldHeadState, so
// it reflects the authoritative current view of each branch.

import type { DiffItem, Entity, GraphDiff, Relation } from '@archi-graph/shared';
import type { Db } from '../db/client';
import { foldHeadState } from '../model/fold';
import { entityEquals, relationEquals } from './equality';

/**
 * True iff two entities differ in any payload field. Identity (entityId) is
 * assumed equal by the caller. Order-irrelevant arrays (metadata.tags, links)
 * compare as SETS via the shared entityEquals helper, so a mere reorder is NOT
 * an `updated`; ordered data (flow) stays positional.
 */
function entityChanged(a: Entity, b: Entity): boolean {
  return !entityEquals(a, b);
}

/**
 * True iff two relations differ in a way that matters for the diff. Explicitly
 * includes BOTH endpoints (source/target) so a repoint registers as `updated`
 * — the Review Focus constraint — plus kind and label.
 */
function relationChanged(a: Relation, b: Relation): boolean {
  return !relationEquals(a, b);
}

/**
 * Generic set-diff over an id-keyed collection. `changed(before, after)`
 * decides whether a pair present on both sides counts as `updated`.
 */
function diffById<T>(
  baseItems: T[],
  candidateItems: T[],
  idOf: (item: T) => string,
  changed: (before: T, after: T) => boolean,
): DiffItem<T>[] {
  const baseMap = new Map(baseItems.map((i) => [idOf(i), i]));
  const candMap = new Map(candidateItems.map((i) => [idOf(i), i]));
  const items: DiffItem<T>[] = [];

  // added / updated: iterate the candidate side.
  for (const [id, after] of candMap) {
    const before = baseMap.get(id);
    if (before === undefined) {
      items.push({ kind: 'added', before: null, after, id });
    } else if (changed(before, after)) {
      items.push({ kind: 'updated', before, after, id });
    }
  }

  // deleted: present on base, absent on candidate.
  for (const [id, before] of baseMap) {
    if (!candMap.has(id)) {
      items.push({ kind: 'deleted', before, after: null, id });
    }
  }

  return items;
}

/**
 * Diffs two branches by folding each head-state and comparing by stable id.
 * `baseBranchId` is the "before" side, `candidateBranchId` the "after".
 */
export async function diffBranches(
  db: Db,
  baseBranchId: string,
  candidateBranchId: string,
): Promise<GraphDiff> {
  const [base, candidate] = await Promise.all([
    foldHeadState(db, baseBranchId),
    foldHeadState(db, candidateBranchId),
  ]);

  return {
    entities: diffById(
      base.entities,
      candidate.entities,
      (e) => e.entityId,
      entityChanged,
    ),
    relations: diffById(
      base.relations,
      candidate.relations,
      (r) => r.relationId,
      relationChanged,
    ),
  };
}
