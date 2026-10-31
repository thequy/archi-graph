// HTTP surface for candidate branches and graph diff.
//
//   POST /branches            body { name, fromBranchId } -> { branchId }
//   GET  /branches                                        -> BranchSummary[]
//   GET  /diff?base=&candidate=                           -> GraphDiff
//
// A create against a non-existent `fromBranchId` surfaces the engine's typed
// BranchNotFoundError as a clean 404. The diff endpoint requires both query
// params; a missing one is a 400.

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type { GraphDiff } from '@archi-graph/shared';
import type { Db } from '../db/client';
import { BranchNotFoundError } from '../model/commit.service';
import { DB_TOKEN } from '../model/tokens';
import {
  BranchService,
  type BranchSummary,
  type CreateCandidateResult,
} from './branch.service';
import { CreateBranchDto, MergeBranchDto } from './dto';
import { diffBranches } from './diff';
import { mergeCandidate, MergeError, type MergeResult } from './merge';

@Controller()
export class VersioningController {
  constructor(
    @Inject(BranchService) private readonly branches: BranchService,
    @Inject(DB_TOKEN) private readonly db: Db,
  ) {}

  @Post('branches')
  async createBranch(
    @Body() dto: CreateBranchDto,
  ): Promise<CreateCandidateResult> {
    try {
      return await this.branches.createCandidate(dto.name, dto.fromBranchId);
    } catch (err) {
      if (err instanceof BranchNotFoundError) {
        throw new NotFoundException(`branch not found: ${dto.fromBranchId}`);
      }
      throw err;
    }
  }

  @Get('branches')
  async listBranches(): Promise<BranchSummary[]> {
    return this.branches.listBranches();
  }

  @Get('diff')
  async diff(
    @Query('base') base?: string,
    @Query('candidate') candidate?: string,
  ): Promise<GraphDiff> {
    if (!base || !candidate) {
      throw new BadRequestException(
        'both `base` and `candidate` query params are required',
      );
    }
    return diffBranches(this.db, base, candidate);
  }

  @Post('branches/:candidateId/merge')
  async merge(
    @Param('candidateId') candidateId: string,
    @Body() dto: MergeBranchDto,
  ): Promise<MergeResult> {
    try {
      return await mergeCandidate(this.db, candidateId, {
        resolutions: dto.resolutions,
      });
    } catch (err) {
      if (err instanceof MergeError) {
        throw new NotFoundException(err.message);
      }
      throw err;
    }
  }
}
