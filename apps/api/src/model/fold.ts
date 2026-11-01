// Fold the materialized head-state tables back into typed domain DTOs.
//
// The head_entities / head_relations tables are the per-branch MATERIALIZED
// head-state: they already reflect the LATEST op per id in commit order,
// because the commit engine keeps them in sync (upsert on add/update,
// delete on delete). So folding is a straight read + row->DTO mapping; the
// "fold semantics" (latest-op-wins, delete-then-add resurrection) live in the
// commit engine's maintenance of these tables, not here.

import { eq } from 'drizzle-orm';
import type {
  Entity,
  EntityMetadata,
  EntityType,
  Group,
  HeadState,
  DiagramSpec,
  LinkRef,
  Relation,
  RelationKind,
  Tier,
} from '@archi-graph/shared';
import type { Db } from '../db/client';
import { headEntities, headRelations } from '../db/schema';

type HeadEntityRow = typeof headEntities.$inferSelect;
type HeadRelationRow = typeof headRelations.$inferSelect;

function rowToEntity(row: HeadEntityRow): Entity {
  return {
    entityId: row.entityId,
    type: row.type as EntityType,
    code: row.code,
    shortTitle: row.shortTitle,
    group: row.group as Group,
    tier: row.tier as Tier,
    title: row.title,
    metadata: row.metadataJson as EntityMetadata,
    contentMarkdown: row.contentMarkdown,
    flow: row.flowJson ?? null,
    links: (row.linksJson as LinkRef[]) ?? [],
    diagrams: (row.diagramsJson as DiagramSpec[] | null) ?? undefined,
    appliesPatterns: (row.appliesPatternsJson as string[] | null) ?? undefined,
  };
}

function rowToRelation(row: HeadRelationRow): Relation {
  return {
    relationId: row.relationId,
    sourceEntityId: row.sourceEntityId,
    targetEntityId: row.targetEntityId,
    kind: row.kind as RelationKind,
    label: row.label,
  };
}

/**
 * Reads the authoritative current view of a branch from the materialized
 * head-state tables and returns typed Entity[] / Relation[].
 */
export async function foldHeadState(
  db: Db,
  branchId: string,
): Promise<HeadState> {
  const [entityRows, relationRows] = await Promise.all([
    db.select().from(headEntities).where(eq(headEntities.branchId, branchId)),
    db.select().from(headRelations).where(eq(headRelations.branchId, branchId)),
  ]);

  return {
    entities: entityRows.map(rowToEntity),
    relations: relationRows.map(rowToRelation),
  };
}
