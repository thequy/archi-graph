// Patterns module — the GLOBAL pattern catalog + the "used-by" reverse lookup.
//
// Patterns are GLOBAL (no project_id) and NOT versioned: a plain CRUD table
// keyed by a human-readable `slug` (Global Constraint). An entity "applies" a
// pattern by listing the pattern's slug in its head_entities.applies_patterns_json
// array (Task 10). `usedBy(slug)` is the reverse lookup: it finds every entity
// that applies a given pattern.
//
// ── used-by scope: MAIN BRANCHES ONLY (Review Focus / Global Constraint) ──
// usedBy() is the ONE intentional cross-project read in the system, and it is
// strictly read-only. It scans the head_entities of the `main` branch of EVERY
// project — NEVER candidate branches. A pattern applied on an unmerged candidate
// must NOT appear in used-by until that candidate is merged into main. We get
// this by JOINing head_entities -> branches and filtering `branches.name = 'main'`.
// Because every project has exactly one `main` branch (ensureProjectMain), this
// yields one row per (project, entity) applying the pattern.
//
// ── jsonb slug membership ──
// applies_patterns_json is a jsonb ARRAY of string slugs (e.g. ["cqrs","saga"]).
// We test membership with the jsonb containment operator `@>`: the column
// contains the one-element array [slug]. Containment on a jsonb array means
// "every element of the right operand appears in the left array", so
// `applies_patterns_json @> '["cqrs"]'::jsonb` is true exactly when "cqrs" is an
// element of the array. We parameterize the slug as a json-encoded single-element
// array via `jsonb_build_array(slug)` so the slug value is bound safely (no string
// interpolation). The `@>` form is index-friendly (GIN) if we ever add an index;
// it also correctly ignores NULL applies_patterns_json rows (NULL @> x is NULL,
// i.e. not true).

import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { branches, headEntities, patterns, projects } from '../db/schema';
import type { CreatePatternDto, UpdatePatternDto } from './dto';

export interface Pattern {
  id: string;
  slug: string;
  name: string;
  category: string;
  intent: string;
  whenToUse: string;
  pros: string;
  cons: string;
  mermaid: string | null;
  kind: string | null;
  flow: unknown | null;
  createdAt: Date;
}

/** One entity (on some project's `main`) that applies a given pattern. */
export interface UsedByItem {
  projectId: string;
  projectName: string;
  entityId: string;
  code: string;
  title: string;
}

@Injectable()
export class PatternService {
  constructor(private readonly db: Db) {}

  /** Lists the whole catalog, alphabetically by name. */
  async list(): Promise<Pattern[]> {
    const rows = await this.db.select().from(patterns);
    return rows
      .map((r) => this.toPattern(r))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Returns the pattern by slug, or null if it does not exist. */
  async get(slug: string): Promise<Pattern | null> {
    const rows = await this.db
      .select()
      .from(patterns)
      .where(eq(patterns.slug, slug));
    return rows.length > 0 ? this.toPattern(rows[0]) : null;
  }

  /** Creates a catalog entry. Returns the inserted row. */
  async create(dto: CreatePatternDto): Promise<Pattern> {
    const [row] = await this.db
      .insert(patterns)
      .values({
        slug: dto.slug,
        name: dto.name,
        category: dto.category,
        intent: dto.intent,
        whenToUse: dto.whenToUse,
        pros: dto.pros,
        cons: dto.cons,
        mermaid: dto.mermaid ?? null,
        kind: dto.kind ?? null,
        flowJson: dto.flow ?? null,
      })
      .returning();
    return this.toPattern(row);
  }

  /**
   * Updates the catalog entry addressed by `slug`. Only keys present in `dto`
   * are changed. Returns the updated row, or null if the slug does not exist.
   */
  async update(slug: string, dto: UpdatePatternDto): Promise<Pattern | null> {
    const set: Record<string, unknown> = {};
    if (dto.name !== undefined) set.name = dto.name;
    if (dto.category !== undefined) set.category = dto.category;
    if (dto.intent !== undefined) set.intent = dto.intent;
    if (dto.whenToUse !== undefined) set.whenToUse = dto.whenToUse;
    if (dto.pros !== undefined) set.pros = dto.pros;
    if (dto.cons !== undefined) set.cons = dto.cons;
    if (dto.mermaid !== undefined) set.mermaid = dto.mermaid;
    if (dto.kind !== undefined) set.kind = dto.kind;
    if (dto.flow !== undefined) set.flowJson = dto.flow;

    if (Object.keys(set).length === 0) {
      // Nothing to change — return the current row (or null if absent).
      return this.get(slug);
    }

    const rows = await this.db
      .update(patterns)
      .set(set)
      .where(eq(patterns.slug, slug))
      .returning();
    return rows.length > 0 ? this.toPattern(rows[0]) : null;
  }

  /**
   * Deletes the catalog entry by slug. Returns true if a row was removed,
   * false if the slug did not exist.
   */
  async remove(slug: string): Promise<boolean> {
    const rows = await this.db
      .delete(patterns)
      .where(eq(patterns.slug, slug))
      .returning({ slug: patterns.slug });
    return rows.length > 0;
  }

  /**
   * Reverse lookup: every entity that applies `slug`, scanning ONLY the `main`
   * branch of EVERY project (Review Focus — candidates are excluded). Returns
   * one item per matching (project, entity).
   *
   * SQL shape (see module header): join head_entities -> branches -> projects,
   * filter `branches.name = 'main'`, and test jsonb membership with
   * `head_entities.applies_patterns_json @> jsonb_build_array(:slug)`.
   */
  async usedBy(slug: string): Promise<UsedByItem[]> {
    const rows = await this.db
      .select({
        projectId: projects.id,
        projectName: projects.name,
        entityId: headEntities.entityId,
        code: headEntities.code,
        title: headEntities.title,
      })
      .from(headEntities)
      .innerJoin(branches, eq(headEntities.branchId, branches.id))
      .innerJoin(projects, eq(branches.projectId, projects.id))
      .where(
        and(
          eq(branches.name, 'main'),
          // jsonb array containment: applies_patterns_json ⊇ [slug].
          sql`${headEntities.appliesPatternsJson} @> jsonb_build_array(${slug}::text)`,
        ),
      );
    return rows.map((r) => ({
      projectId: r.projectId,
      projectName: r.projectName,
      entityId: r.entityId,
      code: r.code,
      title: r.title,
    }));
  }

  private toPattern(row: typeof patterns.$inferSelect): Pattern {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      category: row.category,
      intent: row.intent,
      whenToUse: row.whenToUse,
      pros: row.pros,
      cons: row.cons,
      mermaid: row.mermaid ?? null,
      kind: row.kind ?? null,
      flow: row.flowJson ?? null,
      createdAt: row.createdAt,
    };
  }
}

/**
 * Idempotently seeds the pattern catalog from `apps/api/data/patterns-seed.json`.
 * Upserts by slug: a NEW slug is inserted; an EXISTING slug has ONLY its
 * `flow_json` refreshed from the seed (so adding flow examples to the seed
 * backfills patterns seeded before the flow column existed, without clobbering
 * any other catalog field). A re-run is safe and converges. Called at bootstrap
 * alongside the demo-project graph seed.
 *
 * Returns how many catalog rows the seed file declares (not how many were newly
 * inserted) — callers use it only for logging.
 */
export async function seedPatterns(
  db: Db,
  seed: ReadonlyArray<CreatePatternDto>,
): Promise<{ total: number }> {
  if (seed.length === 0) return { total: 0 };
  await db
    .insert(patterns)
    .values(
      seed.map((p) => ({
        slug: p.slug,
        name: p.name,
        category: p.category,
        intent: p.intent,
        whenToUse: p.whenToUse,
        pros: p.pros,
        cons: p.cons,
        mermaid: p.mermaid ?? null,
        kind: p.kind ?? null,
        flowJson: p.flow ?? null,
      })),
    )
    // On a slug that already exists, refresh ONLY flow_json from the seed — this
    // backfills the new flow examples onto rows seeded before the column existed
    // while leaving every other (possibly user-edited) field intact.
    .onConflictDoUpdate({
      target: patterns.slug,
      set: { flowJson: sql`excluded.flow_json` },
    });
  return { total: seed.length };
}
