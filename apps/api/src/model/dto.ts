// Request DTOs for the model CRUD controller.
//
// Validation is enforced with class-validator against the Global Constraints:
//   entity type  ∈ brd|sad|hld|lld|tsd|adr|dp|dia
//   group        ∈ soe|soo|soi|sos|sor|soda
//   tier         ∈ t0|t1|t2|t3|t3d|t4|t5|tx
//   relation kind ∈ hierarchy|semantic
// The const arrays live in @archi-graph/shared (ENTITY_TYPES, GROUPS, TIERS,
// RELATION_KINDS) — we reuse them as the @IsIn allow-lists so the API and the
// domain stay in lock-step.

import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import {
  ENTITY_TYPES,
  GROUPS,
  RELATION_KINDS,
  TIERS,
  type EntityMetadata,
  type EntityType,
  type Group,
  type LinkRef,
  type RelationKind,
  type Tier,
} from '@archi-graph/shared';

/**
 * Body for `POST /branches/:branchId/entities`.
 * `entityId` is optional — the server fills it (UUID) when absent. Nested
 * `metadata` / `links` shapes are passed through as-is (they are not part of
 * the enum constraints this task must enforce) but are type/shape-checked.
 */
export class EntityDto {
  @IsOptional()
  @IsString()
  entityId?: string;

  @IsIn(ENTITY_TYPES as readonly string[])
  type!: EntityType;

  @IsString()
  code!: string;

  @IsString()
  shortTitle!: string;

  @IsIn(GROUPS as readonly string[])
  group!: Group;

  @IsIn(TIERS as readonly string[])
  tier!: Tier;

  @IsString()
  title!: string;

  @IsObject()
  metadata!: EntityMetadata;

  @IsString()
  contentMarkdown!: string;

  @IsOptional()
  flow?: unknown | null;

  @IsArray()
  links!: LinkRef[];
}

/**
 * Body for `POST /branches/:branchId/relations`.
 * `relationId` is optional — the server fills it (UUID) when absent.
 */
export class RelationDto {
  @IsOptional()
  @IsString()
  relationId?: string;

  @IsString()
  sourceEntityId!: string;

  @IsString()
  targetEntityId!: string;

  @IsIn(RELATION_KINDS as readonly string[])
  kind!: RelationKind;

  @IsString()
  label!: string;
}
