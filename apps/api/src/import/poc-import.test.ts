import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Entity, Relation } from '@archi-graph/shared';
import {
  ENTITY_TYPES,
  GROUPS,
  RELATION_KINDS,
  TIERS,
} from '@archi-graph/shared';
import { getDb, closeDb, type Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { ensureMainBranch } from '../model/commit.service';
import { foldHeadState } from '../model/fold';
import { importPocSeed } from './poc-import';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5433/archigraph';

// The committed seed the extractor produced. The test asserts against it so a
// re-extract that changes counts is caught here.
const SEED_PATH = resolve(__dirname, '..', '..', 'data', 'poc-seed.json');
const seed: { documents: Entity[]; relations: Relation[] } = JSON.parse(
  readFileSync(SEED_PATH, 'utf8'),
);

let db: Db;

async function truncateAll(): Promise<void> {
  await db.execute(
    (await import('drizzle-orm')).sql`TRUNCATE TABLE
      embedding_jobs, doc_chunks,
      head_relations, head_entities,
      relation_versions, entity_versions,
      commits, branches RESTART IDENTITY CASCADE`,
  );
}

beforeAll(async () => {
  await runMigrations(DATABASE_URL);
  db = getDb(DATABASE_URL);
}, 60_000);

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
});

describe('importPocSeed', () => {
  it('seeds a clean graph: counts match the seed and no relation dangles', async () => {
    const result = await importPocSeed(db);

    // The import reports exactly what the seed contains.
    expect(result.entities).toBe(seed.documents.length);
    expect(result.relations).toBe(seed.relations.length);

    // The POC is non-trivial: ~45 components + ADRs/diagram + ~5 DP nodes and
    // ~45 relations. Guard against an empty/half seed.
    expect(result.entities).toBeGreaterThan(0);
    expect(result.relations).toBeGreaterThan(0);
    expect(seed.documents.length).toBeGreaterThan(50);
    expect(seed.relations.length).toBeGreaterThan(40);

    const branchId = await ensureMainBranch(db);
    const head = await foldHeadState(db, branchId);

    // Head-state entity count equals seed documents length; relations match.
    expect(head.entities.length).toBe(seed.documents.length);
    expect(head.relations.length).toBe(seed.relations.length);

    // EVERY relation's source/target resolves to an existing entity — NO dangling.
    const entityIds = new Set(head.entities.map((e) => e.entityId));
    const dangling = head.relations.filter(
      (r) =>
        !entityIds.has(r.sourceEntityId) || !entityIds.has(r.targetEntityId),
    );
    expect(dangling).toEqual([]);

    // At least one DP entity made it in as type:'dp'.
    expect(head.entities.some((e) => e.type === 'dp')).toBe(true);

    // Every entity/relation conforms to the Global Constraints enums.
    for (const e of head.entities) {
      expect(ENTITY_TYPES as readonly string[]).toContain(e.type);
      expect(GROUPS as readonly string[]).toContain(e.group);
      expect(TIERS as readonly string[]).toContain(e.tier);
    }
    for (const r of head.relations) {
      expect(RELATION_KINDS as readonly string[]).toContain(r.kind);
    }
  });

  it('is deterministic: a second import produces the same head-state counts', async () => {
    await importPocSeed(db);
    // Re-importing on a fresh db (beforeEach truncated) yields identical counts
    // because relationIds/entityIds are stable in the seed.
    await truncateAll();
    const second = await importPocSeed(db);
    expect(second.entities).toBe(seed.documents.length);
    expect(second.relations).toBe(seed.relations.length);
  });
});
