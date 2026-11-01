// Shared domain types & DTOs for the Archi-Graph platform.
// Imported by every downstream package/app (NestJS API, Vite+React web).

export type EntityType =
  | 'brd'
  | 'sad'
  | 'hld'
  | 'lld'
  | 'tsd'
  | 'adr'
  | 'dp'
  | 'dia';

export type Group = 'soe' | 'soo' | 'soi' | 'sos' | 'sor' | 'soda';

export type Tier = 't0' | 't1' | 't2' | 't3' | 't3d' | 't4' | 't5' | 'tx';

export type RelationKind = 'hierarchy' | 'semantic';

export type VersionOp = 'add' | 'update' | 'delete';

export interface LinkRef {
  provider: 'sharepoint' | 'confluence' | 'github' | 'gitlab' | 'drawio' | 'other';
  name: string;
  url: string;
}

export interface EntityMetadata {
  author: string;
  date: string;
  status: string;
  tags: string[];
}

/**
 * A single Mermaid-source diagram stored per-entity (Slice B). `kind`
 * distinguishes a C4-style System diagram from a Sequence diagram; `mermaid`
 * holds the raw Mermaid source the FE renders/edits. Diagrams carry a display
 * order, so they are compared POSITIONALLY in diff/merge (unlike tags/links).
 */
export interface DiagramSpec {
  id: string;
  kind: 'system' | 'sequence';
  title: string;
  mermaid: string;
}

export interface Entity {
  entityId: string;
  type: EntityType;
  code: string;
  shortTitle: string;
  group: Group;
  tier: Tier;
  title: string;
  metadata: EntityMetadata;
  contentMarkdown: string;
  flow: unknown | null;
  links: LinkRef[];
  /**
   * Mermaid-source diagrams for this entity (Slice B). Optional/versioned:
   * threaded through commit → entity_versions → head_entities → fold and
   * compared positionally in entityEquals. Absent (undefined) for entities
   * with no diagrams.
   */
  diagrams?: DiagramSpec[];
}

export interface Relation {
  relationId: string;
  sourceEntityId: string;
  targetEntityId: string;
  kind: RelationKind;
  label: string;
}

export interface HeadState {
  entities: Entity[];
  relations: Relation[];
}

export interface DiffItem<T> {
  kind: 'added' | 'updated' | 'deleted';
  before: T | null;
  after: T | null;
  id: string;
}

export interface GraphDiff {
  entities: DiffItem<Entity>[];
  relations: DiffItem<Relation>[];
}

export interface BlastNode {
  entityId: string;
  distance: number;
  via: 'baseline' | 'candidate';
  cause: string[];
}

export interface BlastRadius {
  direction: 'downstream' | 'upstream';
  nodes: BlastNode[];
}

export interface Citation {
  entityId: string;
  code: string;
  shortTitle: string;
}

export interface RagAnswer {
  answer: string;
  citations: Citation[];
}

// ─── Merge contract ───────────────────────────────────────────────────────
// Canonical merge types shared by the API merge endpoint
// (POST /branches/:candidateId/merge, apps/api/src/versioning/merge.ts) and the
// web client (apps/web/src/api/client.ts). Both sides import these so the
// request/response shapes can never diverge.

/** Caller-supplied resolution for a conflicting id: pick a side. */
export type MergeResolutionChoice = 'ours' | 'theirs';

/** The granularity at which a merge conflict is reported. */
export type MergeConflictKind = 'entity' | 'relation' | 'referential';

/** A single unresolved conflict surfaced by a merge attempt. */
export interface MergeConflict {
  kind: MergeConflictKind;
  id: string;
  base: unknown | null;
  ours: unknown | null;
  theirs: unknown | null;
}

/** Outcome of a merge: either a clean commit or a set of conflicts to resolve. */
export type MergeResult =
  | { status: 'clean'; commitId: string }
  | { status: 'conflict'; conflicts: MergeConflict[] };

/** Map of conflict id -> chosen side, replayed on a merge retry. */
export type MergeResolutions = Record<string, MergeResolutionChoice>;

// Runtime const arrays mirroring the union types above.
export const ENTITY_TYPES = [
  'brd',
  'sad',
  'hld',
  'lld',
  'tsd',
  'adr',
  'dp',
  'dia',
] as const satisfies readonly EntityType[];

export const GROUPS = [
  'soe',
  'soo',
  'soi',
  'sos',
  'sor',
  'soda',
] as const satisfies readonly Group[];

export const TIERS = [
  't0',
  't1',
  't2',
  't3',
  't3d',
  't4',
  't5',
  'tx',
] as const satisfies readonly Tier[];

export const RELATION_KINDS = [
  'hierarchy',
  'semantic',
] as const satisfies readonly RelationKind[];

export function isEntityType(x: string): x is EntityType {
  return (ENTITY_TYPES as readonly string[]).includes(x);
}
