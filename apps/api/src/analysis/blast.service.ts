// Blast-radius analysis — cycle-safe recursive CTE over a branch head-state.
//
// ─────────────────────────────────────────────────────────────────────────────
// DIRECTION SEMANTICS (the main judgement call — documented, kept consistent
// with blast.service.test.ts):
//
//   Relations are stored source -> target meaning "source calls/uses target"
//   (the processing flow, e.g. frontend -> gateway -> bff -> backend -> core;
//   X -> Y reads "X calls/uses Y"). "Blast radius" = what a change or failure in
//   a node N can REACH / affect.
//
//   • DOWNSTREAM = the IMPACT of a change to N = N's DEPENDENTS (the callers
//     that break when N changes). A dependent of N is a node that CALLS N, i.e.
//     an edge X -> N. So downstream traversal walks edges BACKWARD: from a
//     frontier node `current`, follow relations whose TARGET = current and emit
//     the SOURCE. For chain A->B->C, downstream of C = {B (d1), A (d2)}.
//
//   • UPSTREAM = N's DEPENDENCIES = the things N itself calls/uses. From
//     `current`, follow relations whose SOURCE = current and emit the TARGET.
//     For chain A->B->C, upstream of A = {B (d1), C (d2)}.
//
//   This matches the brief: "downstream = follow edges toward DEPENDENTS (who
//   depends on this node); upstream = the reverse."
//
// ─────────────────────────────────────────────────────────────────────────────
// CYCLE SAFETY (Global Constraint + Review Focus):
//
//   The recursive CTE carries the full `path` of entity ids visited on the way
//   to each node. A candidate next node is only expanded when it does NOT
//   already appear in that path (`next <> ALL(path)`). This bounds every walk:
//   a cyclic graph such as A->B->A terminates because once a node is on the
//   current path it is never re-entered. After the CTE, results are de-duplicated
//   to the SHORTEST distance per entity so each reached node appears exactly once.
//   The query root itself is never emitted as a result node.
//
//   An optional `maxDepth` caps the number of hops (distance <= maxDepth).
//
// ─────────────────────────────────────────────────────────────────────────────
// Reads strictly from the per-branch MATERIALIZED head-state (head_relations),
// never from historical folds — the authoritative current view of the branch.

import { sql } from 'drizzle-orm';
import type {
  BlastNode,
  BlastRadius,
  DiffItem,
  Entity,
  Relation,
} from '@archi-graph/shared';
import type { Db } from '../db/client';
import { diffBranches } from '../versioning/diff';

type Direction = 'downstream' | 'upstream';
type Graph = 'baseline' | 'candidate';

/** A single reachable node as returned by the recursive-CTE query. */
interface ReachedRow {
  entity_id: string;
  distance: number;
}

/**
 * Walks the head-state relation graph of ONE branch from `rootId` and returns
 * every reachable node with its shortest hop distance. Pure traversal — the
 * `via` / `cause` fields are attached by the callers.
 *
 * For `direction = 'downstream'` we follow edges BACKWARD (target -> source):
 * the dependents/callers of each node. For `'upstream'` we follow edges FORWARD
 * (source -> target): the dependencies each node calls.
 */
async function reachFrom(
  db: Db,
  branchId: string,
  rootId: string,
  direction: Direction,
  maxDepth?: number,
): Promise<ReachedRow[]> {
  // Pick which endpoint matches the current frontier node and which endpoint we
  // step to, based on direction. downstream: match TARGET, step to SOURCE
  // (callers). upstream: match SOURCE, step to TARGET (callees).
  const matchCol = direction === 'downstream' ? 'target_entity_id' : 'source_entity_id';
  const stepCol = direction === 'downstream' ? 'source_entity_id' : 'target_entity_id';

  // Optional depth cap applied inside the recursive step (distance stays
  // <= maxDepth). When undefined, no cap is applied.
  const depthGuard =
    maxDepth === undefined ? sql`` : sql`AND w.distance < ${maxDepth}`;

  const query = sql`
    WITH RECURSIVE walk(node, distance, path) AS (
      -- Seed: the query root at distance 0 with itself on the path.
      SELECT ${rootId}::text, 0, ARRAY[${rootId}::text]
      UNION ALL
      SELECT
        r.${sql.raw(stepCol)},
        w.distance + 1,
        w.path || r.${sql.raw(stepCol)}
      FROM walk w
      JOIN head_relations r
        ON r.branch_id = ${branchId}
       AND r.${sql.raw(matchCol)} = w.node
       -- Cycle guard: never re-enter a node already on this path.
       AND r.${sql.raw(stepCol)} <> ALL(w.path)
      ${depthGuard}
    )
    SELECT node AS entity_id, MIN(distance) AS distance
    FROM walk
    WHERE node <> ${rootId}   -- never emit the root itself
    GROUP BY node
    ORDER BY MIN(distance), node
  `;

  const res = await db.execute(query);
  return (res.rows as { entity_id: string; distance: number | string }[]).map(
    (row) => ({ entity_id: row.entity_id, distance: Number(row.distance) }),
  );
}

/**
 * Single-node blast radius: the reachable impact set of ONE node on ONE branch.
 *
 * Every returned BlastNode carries `via: 'baseline'` (a single-branch query has
 * no candidate graph to attribute to — 'baseline' is the sole/neutral graph)
 * and `cause: [entityId]` (the single query root is the sole cause of reaching
 * each node). These fields carry their meaningful distinctions in the candidate
 * variant below; here they are documented, stable constants.
 */
export async function blastRadiusForNode(
  db: Db,
  branchId: string,
  entityId: string,
  direction: Direction,
  maxDepth?: number,
): Promise<BlastRadius> {
  const reached = await reachFrom(db, branchId, entityId, direction, maxDepth);
  const nodes: BlastNode[] = reached.map((r) => ({
    entityId: r.entity_id,
    distance: r.distance,
    via: 'baseline',
    cause: [entityId],
  }));
  return { direction, nodes };
}

/** Entity ids on the diff, split by whether they traverse baseline or candidate. */
function sourcesByGraph(entityDiff: DiffItem<Entity>[]): {
  baseline: string[];
  candidate: string[];
} {
  const baseline: string[] = [];
  const candidate: string[] = [];
  for (const item of entityDiff) {
    // delete / update changes concern the node as it exists on the BASELINE
    // head-state (the thing being removed/altered); add changes concern the
    // node as it exists on the CANDIDATE head-state (the newly introduced node).
    if (item.kind === 'added') {
      candidate.push(item.id);
    } else {
      baseline.push(item.id);
    }
  }
  return { baseline, candidate };
}

/**
 * Candidate "Workbench simulation" blast radius.
 *
 * Sources = the entity ids that changed between base and candidate
 * (diffBranches). Each source is traversed on the correct graph:
 *   • a DELETE or UPDATE source is traversed on the BASELINE head-state — its
 *     impact is defined by the graph BEFORE the change;
 *   • an ADD source is traversed on the CANDIDATE head-state — a brand-new node
 *     only exists there.
 *
 * Results from both graphs are merged. Each BlastNode records `via` (which graph
 * it was reached through) and `cause` (the source entity ids that reached it).
 * When the same node is reached from both graphs we keep the SHORTEST distance
 * and union the causes; `via` prefers 'candidate' when a node is reached in both
 * (the candidate graph is the simulated end-state the Workbench is previewing).
 */
export async function blastRadiusForCandidate(
  db: Db,
  baseBranchId: string,
  candidateBranchId: string,
  direction: Direction,
): Promise<BlastRadius> {
  const diff = await diffBranches(db, baseBranchId, candidateBranchId);
  const { baseline, candidate } = sourcesByGraph(diff.entities);

  // Accumulate per-entity: shortest distance, union of causes, chosen graph.
  const acc = new Map<
    string,
    { distance: number; causes: Set<string>; via: Graph }
  >();

  const absorb = async (
    branchId: string,
    graph: Graph,
    sources: string[],
  ): Promise<void> => {
    for (const source of sources) {
      const reached = await reachFrom(db, branchId, source, direction);
      for (const row of reached) {
        const existing = acc.get(row.entity_id);
        if (existing === undefined) {
          acc.set(row.entity_id, {
            distance: row.distance,
            causes: new Set([source]),
            via: graph,
          });
          continue;
        }
        existing.causes.add(source);
        if (row.distance < existing.distance) existing.distance = row.distance;
        // Prefer candidate attribution when reached via both graphs.
        if (graph === 'candidate') existing.via = 'candidate';
      }
    }
  };

  // Traverse baseline sources on the base branch, candidate sources on the
  // candidate branch.
  await absorb(baseBranchId, 'baseline', baseline);
  await absorb(candidateBranchId, 'candidate', candidate);

  const nodes: BlastNode[] = [...acc.entries()]
    .map(([entityId, v]) => ({
      entityId,
      distance: v.distance,
      via: v.via,
      cause: [...v.causes].sort(),
    }))
    .sort((a, b) =>
      a.distance - b.distance || a.entityId.localeCompare(b.entityId),
    );

  return { direction, nodes };
}
