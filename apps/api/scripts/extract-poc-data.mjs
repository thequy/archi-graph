// extract-poc-data.mjs
//
// Extracts the CorpDigi POC dataset from the repo-root `index.html` and emits
// `apps/api/data/poc-seed.json` = { documents: Entity[], relations: Relation[] }.
//
// WHY EXECUTE, NOT PARSE: the POC `documents` array is NOT static JSON. It is
// built at runtime by a `doc({...})` FACTORY that fills metadata defaults and
// composes `contentMarkdown` from title/desc/tech/children. An IIFE
// (`linkPatternsIntoGraph`) then PUSHES a handful of design-pattern nodes into
// `documents` (as type:'dp') and their relations into `relations`. A static
// parse would miss the materialized contentMarkdown/metadata and the DP nodes.
// So we extract the SAMPLE DATA <script> block verbatim and run it inside a
// node:vm sandbox, then read the resulting `documents`/`relations` globals.
//
// Mapping (brief + Global Constraints):
//   POC id            -> entityId
//   type/code/shortTitle/group/tier/title/contentMarkdown/flow -> kept as-is
//   POC metadata      -> metadata
//   POC links         -> links (default [])
//   DP nodes          -> kept as type:'dp'
//   relation source   -> sourceEntityId
//   relation target   -> targetEntityId
//   relation kind/label -> kept
//   relationId        -> STABLE id derived from source+target+kind (re-runs
//                         are deterministic; no UUIDs).
//
// Enum conformance (type/group/tier/kind) is CHECKED. Dangling relation
// endpoints are CHECKED. On any violation the script REPORTS and exits non-zero
// rather than silently coercing or dropping — per the task's global constraints.
//
// KNOWN NON-CONFORMANCE (reported & normalized by explicit decision):
// The 5 DP nodes pushed by the POC's `linkPatternsIntoGraph` IIFE (dp-mfe,
// dp-bff, dp-cqrs, dp-saga, dp-outbox) are created WITHOUT `group` or `tier`
// — the POC renders them via a type-color fallback and shows System/Tier only
// when present. Our Entity/DB schema require conforming group+tier NOT NULL.
// Per decision we normalize each DP node to:
//   tier  = 'tx'  (same as every ADR/DIA cross-cutting doc)
//   group = the group of the COMPONENT the DP applies to (the `source` of the
//           POC relation whose `target` is the DP id). Deterministic, derived
//           from the POC's own `applies` wiring — not an arbitrary constant.
// This normalization is logged. Any OTHER non-conformance still hard-fails.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));

// scripts/ -> apps/api -> apps -> <repo/worktree root>
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const INDEX_HTML = resolve(REPO_ROOT, 'index.html');
const OUT_DIR = resolve(__dirname, '..', 'data');
const OUT_FILE = resolve(OUT_DIR, 'poc-seed.json');

// --- Enum allow-lists (mirror @archi-graph/shared / Global Constraints) -------
const ENTITY_TYPES = ['brd', 'sad', 'hld', 'lld', 'tsd', 'adr', 'dp', 'dia'];
const GROUPS = ['soe', 'soo', 'soi', 'sos', 'sor', 'soda'];
const TIERS = ['t0', 't1', 't2', 't3', 't3d', 't4', 't5', 'tx'];
const RELATION_KINDS = ['hierarchy', 'semantic'];

/**
 * Pulls the SAMPLE DATA <script> block out of index.html. We anchor on the
 * `<!-- ... SAMPLE DATA ... -->` comment that precedes it, then take the body
 * of the immediately following <script>...</script>. This block defines
 * `doc()`, `documents`, `relations`, `designPatterns`, `nodeStyle`, and the
 * `linkPatternsIntoGraph` IIFE — everything we need, with no DOM/THREE deps.
 */
function extractDataScript(html) {
  const marker = html.indexOf('SAMPLE DATA');
  if (marker === -1) {
    throw new Error('Could not find the "SAMPLE DATA" marker in index.html');
  }
  const scriptOpen = html.indexOf('<script>', marker);
  if (scriptOpen === -1) {
    throw new Error('No <script> found after the SAMPLE DATA marker');
  }
  const bodyStart = scriptOpen + '<script>'.length;
  const scriptClose = html.indexOf('</script>', bodyStart);
  if (scriptClose === -1) {
    throw new Error('Unterminated SAMPLE DATA <script> block');
  }
  return html.slice(bodyStart, scriptClose);
}

/**
 * Deterministic relationId derived from source+target+kind so re-running the
 * extractor (or the import) is stable. Format: `rel:<source>__<kind>__<target>`.
 * Collisions would only occur for an exact duplicate (source,target,kind),
 * which the POC does not contain and which we additionally detect below.
 */
function relationId(source, target, kind) {
  return `rel:${source}__${kind}__${target}`;
}

function main() {
  const html = readFileSync(INDEX_HTML, 'utf8');
  const code = extractDataScript(html);

  // Sandbox: a minimal context. The data script only needs standard JS plus
  // `encodeURIComponent` (a global in Node) — no DOM, no THREE. We expose the
  // few globals the block touches and nothing else.
  const sandbox = {
    encodeURIComponent,
    console,
  };
  const context = vm.createContext(sandbox);

  // Append exports so we can read the globals the block declares with `const`
  // (const does not attach to the context object, so we marshal explicitly).
  const wrapped = `${code}\n;globalThis.__out = { documents, relations };`;
  vm.runInContext(wrapped, context, { filename: 'poc-data.js' });

  const { documents: rawDocs, relations: rawRels } = context.__out;

  if (!Array.isArray(rawDocs) || !Array.isArray(rawRels)) {
    throw new Error('Expected `documents` and `relations` arrays from POC data');
  }

  const problems = [];
  const notes = [];

  // --- Normalize DP nodes missing group/tier (explicit, logged decision) -----
  // Map each raw doc id -> its (pre-normalization) group, so we can inherit.
  const rawGroupById = new Map(rawDocs.map((d) => [d.id, d.group]));
  // DP applies-target: the `source` of the POC relation whose `target` is the
  // DP id (that's how linkPatternsIntoGraph wires `relations.push({source: applies, target: pid})`).
  const dpAppliesTarget = new Map();
  for (const r of rawRels) {
    const targetDoc = rawDocs.find((d) => d.id === r.target);
    if (targetDoc && targetDoc.type === 'dp' && !dpAppliesTarget.has(r.target)) {
      dpAppliesTarget.set(r.target, r.source);
    }
  }
  for (const d of rawDocs) {
    if (d.type !== 'dp') continue;
    if (d.tier == null) {
      d.tier = 'tx';
    }
    if (d.group == null) {
      const appliesTo = dpAppliesTarget.get(d.id);
      const inheritedGroup = appliesTo ? rawGroupById.get(appliesTo) : undefined;
      if (!inheritedGroup) {
        problems.push(
          `DP node "${d.id}" has no group and no resolvable applies-target to inherit one from`,
        );
      } else {
        d.group = inheritedGroup;
        notes.push(
          `normalized DP "${d.id}": tier='tx', group='${inheritedGroup}' (inherited from applies-target "${appliesTo}")`,
        );
      }
    }
  }

  // --- Map documents -> Entity[] --------------------------------------------
  const documents = rawDocs.map((d, i) => {
    const entity = {
      entityId: d.id,
      type: d.type,
      code: d.code,
      shortTitle: d.shortTitle,
      group: d.group,
      tier: d.tier,
      title: d.title,
      metadata: d.metadata,
      contentMarkdown: d.contentMarkdown,
      flow: d.flow ?? null,
      links: d.links ?? [],
    };

    if (!entity.entityId) problems.push(`document[${i}] missing id`);
    if (!ENTITY_TYPES.includes(entity.type))
      problems.push(`document "${entity.entityId}" has non-conforming type "${entity.type}"`);
    if (!GROUPS.includes(entity.group))
      problems.push(`document "${entity.entityId}" has non-conforming group "${entity.group}"`);
    if (!TIERS.includes(entity.tier))
      problems.push(`document "${entity.entityId}" has non-conforming tier "${entity.tier}"`);

    return entity;
  });

  // --- Map relations -> Relation[] ------------------------------------------
  const seenRelIds = new Set();
  const relations = rawRels.map((r, i) => {
    const rid = relationId(r.source, r.target, r.kind);
    if (seenRelIds.has(rid)) {
      problems.push(
        `duplicate relation (source=${r.source}, target=${r.target}, kind=${r.kind}) -> non-unique relationId ${rid}`,
      );
    }
    seenRelIds.add(rid);

    const rel = {
      relationId: rid,
      sourceEntityId: r.source,
      targetEntityId: r.target,
      kind: r.kind,
      label: r.label,
    };

    if (!RELATION_KINDS.includes(rel.kind))
      problems.push(`relation[${i}] (${r.source}->${r.target}) has non-conforming kind "${rel.kind}"`);

    return rel;
  });

  // --- Dangling check: every endpoint must resolve to a document ------------
  const docIds = new Set(documents.map((d) => d.entityId));
  for (const rel of relations) {
    if (!docIds.has(rel.sourceEntityId))
      problems.push(`DANGLING relation source "${rel.sourceEntityId}" (relationId=${rel.relationId}) has no matching document`);
    if (!docIds.has(rel.targetEntityId))
      problems.push(`DANGLING relation target "${rel.targetEntityId}" (relationId=${rel.relationId}) has no matching document`);
  }

  if (problems.length > 0) {
    console.error('POC data did not map cleanly. Problems found:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const seed = { documents, relations };
  writeFileSync(OUT_FILE, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');

  const dpCount = documents.filter((d) => d.type === 'dp').length;
  if (notes.length > 0) {
    console.log('Normalizations applied (reported, not silent):');
    for (const n of notes) console.log(`  - ${n}`);
  }
  console.log(`Wrote ${OUT_FILE}`);
  console.log(`  documents: ${documents.length} (dp: ${dpCount})`);
  console.log(`  relations: ${relations.length}`);
}

main();
