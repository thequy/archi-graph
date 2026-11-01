// Tests for the GLOBAL pattern catalog service + the used-by reverse lookup.
//
// Patterns are GLOBAL (no project_id) and NOT versioned — plain CRUD keyed by
// slug. `usedBy(slug)` scans the `main` branch of EVERY project for entities
// whose applies_patterns_json contains the slug.
//
// Review Focus (Global Constraint): used-by scans ONLY `main` branches. A
// pattern applied on an UNMERGED candidate branch must NOT appear in used-by.
//
// Runs against a REAL Postgres+pgvector (podman, 5434). Serialized api suites;
// tables truncated per test (demo project re-seeded to satisfy v1 FK).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Entity } from '@archi-graph/shared';
import { getDb, closeDb, type Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { CommitService, ensureProjectMain } from '../model/commit.service';
import { BranchService } from '../versioning/branch.service';
import { ProjectService } from '../projects/project.service';
import { PatternService, seedPatterns } from './pattern.service';
import { loadPatternsSeed } from '../boot/bootstrap-db';
import type { CreatePatternDto } from './dto';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5433/archigraph';

let db: Db;
let patterns: PatternService;
let projects: ProjectService;
let commits: CommitService;
let branchService: BranchService;

function makeEntity(overrides: Partial<Entity> & { entityId: string }): Entity {
  return {
    type: 'brd',
    code: 'C1',
    shortTitle: 'short',
    group: 'soe',
    tier: 't0',
    title: 'Title',
    metadata: { author: 'local', date: '2026-01-01', status: 'draft', tags: [] },
    contentMarkdown: '# content',
    flow: null,
    links: [],
    ...overrides,
  };
}

const sampleDto: CreatePatternDto = {
  slug: 'test-pattern',
  name: 'Test Pattern',
  category: 'gof',
  intent: 'intent',
  whenToUse: 'when',
  pros: 'pros',
  cons: 'cons',
  mermaid: 'classDiagram',
  kind: 'behavioral',
};

async function truncateAll(): Promise<void> {
  const { sql } = await import('drizzle-orm');
  await db.execute(
    sql`TRUNCATE TABLE
      patterns,
      embedding_jobs, doc_chunks,
      head_relations, head_entities,
      relation_versions, entity_versions,
      commits, branches, projects RESTART IDENTITY CASCADE`,
  );
  // Re-seed the demo project (v1 suites sharing this DB rely on it for FK).
  await db.execute(
    sql`INSERT INTO projects (id, name)
        VALUES ('11111111-1111-1111-1111-111111111111', 'CorpDigi')
        ON CONFLICT (id) DO NOTHING`,
  );
}

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  await runMigrations(DATABASE_URL);
  db = getDb(DATABASE_URL);
  patterns = new PatternService(db);
  projects = new ProjectService(db);
  commits = new CommitService(db);
  branchService = new BranchService(db);
}, 60_000);

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
});

describe('PatternService CRUD', () => {
  it('create ⇒ get returns it with all fields', async () => {
    const created = await patterns.create(sampleDto);
    expect(typeof created.id).toBe('string');
    expect(created.slug).toBe('test-pattern');
    expect(created.category).toBe('gof');

    const got = await patterns.get('test-pattern');
    expect(got?.name).toBe('Test Pattern');
    expect(got?.mermaid).toBe('classDiagram');
    expect(got?.kind).toBe('behavioral');
  });

  it('get(unknown) ⇒ null', async () => {
    expect(await patterns.get('nope')).toBeNull();
  });

  it('list returns created rows sorted by name', async () => {
    await patterns.create({ ...sampleDto, slug: 'z', name: 'Zed' });
    await patterns.create({ ...sampleDto, slug: 'a', name: 'Alpha' });
    const list = await patterns.list();
    const names = list.map((p) => p.name);
    expect(names).toEqual(['Alpha', 'Zed']);
  });

  it('update changes only the provided fields; update(unknown) ⇒ null', async () => {
    await patterns.create(sampleDto);
    const updated = await patterns.update('test-pattern', { intent: 'new intent' });
    expect(updated?.intent).toBe('new intent');
    expect(updated?.name).toBe('Test Pattern'); // untouched
    expect(await patterns.update('nope', { intent: 'x' })).toBeNull();
  });

  it('remove deletes it; remove(unknown) ⇒ false', async () => {
    await patterns.create(sampleDto);
    expect(await patterns.remove('test-pattern')).toBe(true);
    expect(await patterns.get('test-pattern')).toBeNull();
    expect(await patterns.remove('test-pattern')).toBe(false);
  });

  it('round-trips a flow (nodes+edges jsonb) through create ⇒ get and update', async () => {
    const flow = {
      nodes: [{ id: 'n1', data: { label: 'Command' }, position: { x: 0, y: 0 } }],
      edges: [{ id: 'e1', source: 'n1', target: 'n1' }],
    };
    const created = await patterns.create({ ...sampleDto, slug: 'with-flow', flow });
    expect(created.flow).toEqual(flow);

    const got = await patterns.get('with-flow');
    expect(got?.flow).toEqual(flow);

    // update can replace the flow and null is a valid stored value.
    const nextFlow = { nodes: [], edges: [] };
    const updated = await patterns.update('with-flow', { flow: nextFlow });
    expect(updated?.flow).toEqual(nextFlow);
    const cleared = await patterns.update('with-flow', { flow: null });
    expect(cleared?.flow).toBeNull();
  });

  it('a pattern created without a flow has flow === null', async () => {
    const created = await patterns.create(sampleDto);
    expect(created.flow).toBeNull();
    expect((await patterns.get('test-pattern'))?.flow).toBeNull();
  });
});

describe('seedPatterns (idempotent by slug)', () => {
  it('seeds the catalog; re-running does not error or duplicate; includes singleton + cqrs', async () => {
    const seed = loadPatternsSeed();
    await seedPatterns(db, seed);
    await seedPatterns(db, seed); // idempotent re-run
    const list = await patterns.list();
    expect(list.length).toBe(seed.length);
    const slugs = list.map((p) => p.slug);
    expect(slugs).toContain('singleton');
    expect(slugs).toContain('cqrs');
    // categories are the two allowed values
    for (const p of list) {
      expect(['gof', 'system-design']).toContain(p.category);
    }
  });

  it('system-design patterns carry an example flow after seeding', async () => {
    const seed = loadPatternsSeed();
    await seedPatterns(db, seed);
    const cqrs = await patterns.get('cqrs');
    expect(cqrs?.flow).not.toBeNull();
    const f = cqrs?.flow as { nodes?: unknown[]; edges?: unknown[] };
    expect(Array.isArray(f.nodes)).toBe(true);
    expect(f.nodes!.length).toBeGreaterThan(0);
    expect(Array.isArray(f.edges)).toBe(true);
  });

  it('backfills flow_json onto a pre-existing flowless row WITHOUT clobbering other fields', async () => {
    const seed = loadPatternsSeed();
    const cqrsSeed = seed.find((p) => p.slug === 'cqrs');
    expect(cqrsSeed).toBeDefined();
    expect(cqrsSeed!.flow).toBeDefined();

    // Simulate a DB seeded before the flow column: the row exists, flow is null,
    // and a field (intent) has been hand-edited away from the seed value.
    await patterns.create({ ...cqrsSeed!, flow: undefined, intent: 'user-edited intent' });
    const before = await patterns.get('cqrs');
    expect(before?.flow).toBeNull();

    // Re-seed: ONLY flow_json is refreshed from the seed (onConflictDoUpdate).
    await seedPatterns(db, seed);
    const after = await patterns.get('cqrs');
    expect(after?.flow).toEqual(cqrsSeed!.flow);
    // The hand-edited field is left intact — upsert touches flow_json only.
    expect(after?.intent).toBe('user-edited intent');
  });
});

describe('PatternService.usedBy — main branches only (Review Focus)', () => {
  it('returns an entity applying the slug on a project main branch', async () => {
    const project = await projects.create('Alpha');
    const mainId = await ensureProjectMain(db, project.id);
    await commits.commit(
      mainId,
      {
        entities: [
          {
            op: 'add',
            entity: makeEntity({
              entityId: 'E-cqrs',
              code: 'SAD-9',
              title: 'Read Side',
              appliesPatterns: ['cqrs'],
            }),
          },
        ],
        relations: [],
      },
      'apply cqrs on main',
    );

    const used = await patterns.usedBy('cqrs');
    expect(used.length).toBe(1);
    expect(used[0]).toEqual({
      projectId: project.id,
      projectName: 'Alpha',
      entityId: 'E-cqrs',
      code: 'SAD-9',
      title: 'Read Side',
    });
  });

  it('a slug applied ONLY on an unmerged candidate does NOT appear in used-by', async () => {
    const project = await projects.create('Beta');
    const mainId = await ensureProjectMain(db, project.id);
    // Seed an unrelated entity on main so the candidate has a non-trivial fork.
    await commits.commit(
      mainId,
      {
        entities: [{ op: 'add', entity: makeEntity({ entityId: 'E1', code: 'BRD-1' }) }],
        relations: [],
      },
      'seed main',
    );

    // Fork a candidate and apply 'saga' ONLY there.
    const { branchId: candId } = await branchService.createCandidate('cand', mainId);
    await commits.commit(
      candId,
      {
        entities: [
          {
            op: 'add',
            entity: makeEntity({
              entityId: 'E-saga',
              code: 'SAD-7',
              title: 'Orchestrator',
              appliesPatterns: ['saga'],
            }),
          },
        ],
        relations: [],
      },
      'apply saga on candidate',
    );

    // used-by scans main only ⇒ the candidate-only application is invisible.
    const used = await patterns.usedBy('saga');
    expect(used).toEqual([]);
  });

  it('usedBy(slug with no appliers) ⇒ empty array', async () => {
    expect(await patterns.usedBy('observer')).toEqual([]);
  });

  it('matches one of several applied slugs (jsonb array membership)', async () => {
    const project = await projects.create('Gamma');
    const mainId = await ensureProjectMain(db, project.id);
    await commits.commit(
      mainId,
      {
        entities: [
          {
            op: 'add',
            entity: makeEntity({
              entityId: 'E-multi',
              code: 'HLD-3',
              title: 'Gateway',
              appliesPatterns: ['api-gateway', 'circuit-breaker'],
            }),
          },
        ],
        relations: [],
      },
      'apply two patterns on main',
    );

    const byGateway = await patterns.usedBy('api-gateway');
    expect(byGateway.map((u) => u.entityId)).toEqual(['E-multi']);
    const byBreaker = await patterns.usedBy('circuit-breaker');
    expect(byBreaker.map((u) => u.entityId)).toEqual(['E-multi']);
    // a slug the entity does NOT apply
    expect(await patterns.usedBy('saga')).toEqual([]);
  });
});
