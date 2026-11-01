// Shared payload-equality used by BOTH diff.ts and merge.ts.
//
// Review Focus (IMPORTANT 3): the previous positional array comparison treated
// a mere REORDER of `metadata.tags` or `links` as an `updated` — producing
// phantom diffs and spurious merge conflicts. Those arrays carry NO meaningful
// order (a tag set / a link set), so their comparison must be order-INSENSITIVE.
//
// Genuinely ordered data (entity.flow — reactflow nodes/edges) stays
// order-SENSITIVE: we only relax ordering for the fields we KNOW are sets, and
// fall back to positional deep-equality everywhere else.
//
// Both diff.ts and merge.ts import entityEquals/relationEquals from here so the
// two cannot drift apart (the two files previously held duplicate deepEqual).

import type { Entity, LinkRef, Relation } from '@archi-graph/shared';

/** Positional, stable deep equality for plain JSON-ish values (order-SENSITIVE). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }

  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao).sort();
  const bKeys = Object.keys(bo).sort();
  if (aKeys.length !== bKeys.length) return false;
  if (!aKeys.every((k, i) => k === bKeys[i])) return false;
  return aKeys.every((k) => deepEqual(ao[k], bo[k]));
}

/** Order-insensitive equality for a string[] treated as a SET (e.g. tags). */
function tagsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * Order-insensitive equality for a LinkRef[] treated as a SET. Links are sorted
 * by a stable composite key (provider|name|url) before a positional compare.
 */
function linksEqual(a: LinkRef[], b: LinkRef[]): boolean {
  if (a.length !== b.length) return false;
  const key = (l: LinkRef): string => `${l.provider}\u0000${l.name}\u0000${l.url}`;
  const sa = [...a].sort((x, y) => key(x).localeCompare(key(y)));
  const sb = [...b].sort((x, y) => key(x).localeCompare(key(y)));
  return sa.every((l, i) => deepEqual(l, sb[i]));
}

/**
 * True iff two entities are equal for diff/merge purposes. Identity (entityId)
 * is assumed equal by the caller. `metadata.tags` and `links` compare as SETS
 * (order-insensitive); every other field — including the ordered `flow` — uses
 * positional deep-equality.
 */
export function entityEquals(a: Entity, b: Entity): boolean {
  if (a.type !== b.type) return false;
  if (a.code !== b.code) return false;
  if (a.shortTitle !== b.shortTitle) return false;
  if (a.group !== b.group) return false;
  if (a.tier !== b.tier) return false;
  if (a.title !== b.title) return false;
  if (a.contentMarkdown !== b.contentMarkdown) return false;

  // metadata: tags are a set; the rest is positional.
  if (a.metadata.author !== b.metadata.author) return false;
  if (a.metadata.date !== b.metadata.date) return false;
  if (a.metadata.status !== b.metadata.status) return false;
  if (!tagsEqual(a.metadata.tags ?? [], b.metadata.tags ?? [])) return false;

  // links are a set.
  if (!linksEqual(a.links ?? [], b.links ?? [])) return false;

  // flow is genuinely ordered (reactflow nodes/edges) ⇒ positional.
  if (!deepEqual(a.flow ?? null, b.flow ?? null)) return false;

  // diagrams carry a display order ⇒ positional deep-equal (like flow). A
  // missing array and an empty array are treated as equivalent.
  if (!deepEqual(a.diagrams ?? [], b.diagrams ?? [])) return false;

  // appliesPatterns is a SET of pattern slugs — a component "applies" a set,
  // so slug ORDER is meaningless. Compare order-insensitively (like tags), so a
  // pure reorder is NOT an update. This is the one field that DIFFERS from the
  // positional `diagrams` precedent.
  if (!tagsEqual(a.appliesPatterns ?? [], b.appliesPatterns ?? [])) return false;

  return true;
}

/**
 * True iff two relations differ in a way that matters for the diff/merge.
 * Includes BOTH endpoints so a repoint registers as changed (Review Focus),
 * plus kind and label.
 */
export function relationEquals(a: Relation, b: Relation): boolean {
  return (
    a.sourceEntityId === b.sourceEntityId &&
    a.targetEntityId === b.targetEntityId &&
    a.kind === b.kind &&
    a.label === b.label
  );
}
