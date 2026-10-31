// HTTP surface for the versioned model graph.
//
// Every write is expressed as an immutable commit via CommitService; reads come
// from the materialized head-state via foldHeadState. The controller is thin:
// it validates input (class-validator DTOs + enum allow-lists), enforces the
// two cross-cutting Global Constraints that live at this layer, and translates
// engine errors into clean HTTP status codes:
//
//   - A relation whose source OR target entity is ABSENT in the branch's
//     current head-state is rejected with 400 (no dangling relations).
//   - A write targeting a non-existent branch yields 404 (never a 500): the
//     commit engine throws `branch not found: <id>`, which we map here.

import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type {
  Entity,
  HeadState,
  Relation,
} from '@archi-graph/shared';
import type { Db } from '../db/client';
import { CommitService } from './commit.service';
import { foldHeadState } from './fold';
import { DB_TOKEN } from './tokens';
import { EntityDto, RelationDto } from './dto';

/** Thrown by CommitService when the target branch does not exist. */
function isBranchNotFound(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('branch not found');
}

@Controller('branches/:branchId')
export class ModelController {
  constructor(
    @Inject(CommitService) private readonly commits: CommitService,
    @Inject(DB_TOKEN) private readonly db: Db,
  ) {}

  @Get('graph')
  async getGraph(@Param('branchId') branchId: string): Promise<HeadState> {
    return foldHeadState(this.db, branchId);
  }

  @Post('entities')
  async addEntity(
    @Param('branchId') branchId: string,
    @Body() dto: EntityDto,
    @Query('message') message?: string,
  ): Promise<{ commitId: string; entityId: string }> {
    const entityId = dto.entityId ?? randomUUID();
    const entity: Entity = {
      entityId,
      type: dto.type,
      code: dto.code,
      shortTitle: dto.shortTitle,
      group: dto.group,
      tier: dto.tier,
      title: dto.title,
      metadata: dto.metadata,
      contentMarkdown: dto.contentMarkdown,
      flow: dto.flow ?? null,
      links: dto.links,
    };

    // add vs update: if the id already lives in head-state, it's an update.
    const head = await foldHeadState(this.db, branchId);
    const exists = head.entities.some((e) => e.entityId === entityId);

    const { commitId } = await this.runCommit(
      branchId,
      {
        entities: [{ op: exists ? 'update' : 'add', entity }],
        relations: [],
      },
      message ?? (exists ? `update entity ${entityId}` : `add entity ${entityId}`),
    );
    return { commitId, entityId };
  }

  @Delete('entities/:entityId')
  @HttpCode(200)
  async deleteEntity(
    @Param('branchId') branchId: string,
    @Param('entityId') entityId: string,
    @Query('message') message?: string,
  ): Promise<{ commitId: string; entityId: string }> {
    const head = await foldHeadState(this.db, branchId);
    const existing = head.entities.find((e) => e.entityId === entityId);
    if (!existing) {
      throw new NotFoundException(`entity not found: ${entityId}`);
    }

    const { commitId } = await this.runCommit(
      branchId,
      { entities: [{ op: 'delete', entity: existing }], relations: [] },
      message ?? `delete entity ${entityId}`,
    );
    return { commitId, entityId };
  }

  @Post('relations')
  async addRelation(
    @Param('branchId') branchId: string,
    @Body() dto: RelationDto,
    @Query('message') message?: string,
  ): Promise<{ commitId: string; relationId: string }> {
    const relationId = dto.relationId ?? randomUUID();

    // Global Constraint: no dangling relations. Both endpoints must exist in
    // the branch's CURRENT head-state, else 400.
    const head = await foldHeadState(this.db, branchId);
    const ids = new Set(head.entities.map((e) => e.entityId));
    if (!ids.has(dto.sourceEntityId) || !ids.has(dto.targetEntityId)) {
      throw new BadRequestException(
        'relation endpoints must reference entities present in the branch head-state',
      );
    }

    const relation: Relation = {
      relationId,
      sourceEntityId: dto.sourceEntityId,
      targetEntityId: dto.targetEntityId,
      kind: dto.kind,
      label: dto.label,
    };

    const exists = head.relations.some((r) => r.relationId === relationId);
    const { commitId } = await this.runCommit(
      branchId,
      {
        entities: [],
        relations: [{ op: exists ? 'update' : 'add', relation }],
      },
      message ??
        (exists
          ? `update relation ${relationId}`
          : `add relation ${relationId}`),
    );
    return { commitId, relationId };
  }

  @Delete('relations/:relationId')
  @HttpCode(200)
  async deleteRelation(
    @Param('branchId') branchId: string,
    @Param('relationId') relationId: string,
    @Query('message') message?: string,
  ): Promise<{ commitId: string; relationId: string }> {
    const head = await foldHeadState(this.db, branchId);
    const existing = head.relations.find((r) => r.relationId === relationId);
    if (!existing) {
      throw new NotFoundException(`relation not found: ${relationId}`);
    }

    const { commitId } = await this.runCommit(
      branchId,
      { entities: [], relations: [{ op: 'delete', relation: existing }] },
      message ?? `delete relation ${relationId}`,
    );
    return { commitId, relationId };
  }

  /**
   * Wraps CommitService.commit so the "branch not found" engine error becomes a
   * clean 404 instead of a 500.
   */
  private async runCommit(
    branchId: string,
    changes: Parameters<CommitService['commit']>[1],
    message: string,
  ): Promise<{ commitId: string }> {
    try {
      return await this.commits.commit(branchId, changes, message);
    } catch (err) {
      if (isBranchNotFound(err)) {
        throw new NotFoundException(`branch not found: ${branchId}`);
      }
      throw err;
    }
  }
}
