// HTTP surface for the GLOBAL pattern catalog + the used-by reverse lookup.
//
//   GET    /patterns                 -> Pattern[]
//   GET    /patterns/:slug           -> Pattern | 404
//   POST   /patterns     { ...dto }  -> Pattern (201)
//   PATCH  /patterns/:slug { ...dto } -> Pattern | 404
//   DELETE /patterns/:slug           -> 200 | 404
//   GET    /patterns/:slug/used-by   -> UsedByItem[]   (main branches only)
//
// The controller is thin: validate DTOs, map a missing pattern to a clean 404.
// used-by is read-only and returns an array (empty when nothing applies the
// slug) — it does not 404 on an unknown slug, matching a reverse-index lookup.

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  PatternService,
  type Pattern,
  type UsedByItem,
} from './pattern.service';
import { CreatePatternDto, UpdatePatternDto } from './dto';

@Controller('patterns')
export class PatternsController {
  constructor(
    @Inject(PatternService) private readonly patterns: PatternService,
  ) {}

  @Get()
  async list(): Promise<Pattern[]> {
    return this.patterns.list();
  }

  @Post()
  async create(@Body() dto: CreatePatternDto): Promise<Pattern> {
    return this.patterns.create(dto);
  }

  @Get(':slug')
  async get(@Param('slug') slug: string): Promise<Pattern> {
    const pattern = await this.patterns.get(slug);
    if (!pattern) {
      throw new NotFoundException(`pattern not found: ${slug}`);
    }
    return pattern;
  }

  @Get(':slug/used-by')
  async usedBy(@Param('slug') slug: string): Promise<UsedByItem[]> {
    return this.patterns.usedBy(slug);
  }

  @Patch(':slug')
  async update(
    @Param('slug') slug: string,
    @Body() dto: UpdatePatternDto,
  ): Promise<Pattern> {
    const pattern = await this.patterns.update(slug, dto);
    if (!pattern) {
      throw new NotFoundException(`pattern not found: ${slug}`);
    }
    return pattern;
  }

  @Delete(':slug')
  @HttpCode(200)
  async remove(@Param('slug') slug: string): Promise<{ slug: string }> {
    const deleted = await this.patterns.remove(slug);
    if (!deleted) {
      throw new NotFoundException(`pattern not found: ${slug}`);
    }
    return { slug };
  }
}
