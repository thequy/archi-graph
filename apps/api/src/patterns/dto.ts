// Request DTOs for the Patterns CRUD controller.
//
// Patterns are a GLOBAL, non-versioned catalog (Slice D — Pattern Wiki). The
// DTOs are validated with class-validator against the app's ValidationPipe
// (whitelist + transform). `slug` is the stable key (`/patterns/:slug`); it is
// required on create and is NOT part of the update body (the slug in the path
// identifies the row — rename of slug is out of scope for plain CRUD here).

import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

/** The two catalog categories: classic GoF vs system-design patterns. */
export const PATTERN_CATEGORIES = ['gof', 'system-design'] as const;
export type PatternCategory = (typeof PATTERN_CATEGORIES)[number];

/** Body for `POST /patterns`. All catalog fields; `mermaid`/`kind` optional. */
export class CreatePatternDto {
  @IsString()
  @IsNotEmpty()
  slug!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsIn(PATTERN_CATEGORIES)
  category!: PatternCategory;

  @IsString()
  @IsNotEmpty()
  intent!: string;

  @IsString()
  @IsNotEmpty()
  whenToUse!: string;

  @IsString()
  @IsNotEmpty()
  pros!: string;

  @IsString()
  @IsNotEmpty()
  cons!: string;

  @IsOptional()
  @IsString()
  mermaid?: string;

  @IsOptional()
  @IsString()
  kind?: string;
}

/**
 * Body for `PATCH /patterns/:slug`. Every field is optional — only the keys
 * present are updated. The slug itself is addressed via the path and is not
 * mutated here.
 */
export class UpdatePatternDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsIn(PATTERN_CATEGORIES)
  category?: PatternCategory;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  intent?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  whenToUse?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  pros?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  cons?: string;

  @IsOptional()
  @IsString()
  mermaid?: string;

  @IsOptional()
  @IsString()
  kind?: string;
}
