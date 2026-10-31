// HTTP surface for blast-radius analysis.
//
//   GET /branches/:branchId/blast/:entityId?direction=&maxDepth=
//        -> BlastRadius for a single node on one branch.
//   GET /blast/candidate?base=&candidate=&direction=
//        -> BlastRadius for a candidate change-set (Workbench simulation).
//
// `direction` defaults to 'downstream' (the common "what does changing this
// affect?" question). An unknown direction value is a 400. `maxDepth`, when
// present, must be a positive integer. The candidate endpoint requires both
// `base` and `candidate` query params.

import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
  Query,
} from '@nestjs/common';
import type { BlastRadius } from '@archi-graph/shared';
import type { Db } from '../db/client';
import { DB_TOKEN } from '../model/tokens';
import {
  blastRadiusForCandidate,
  blastRadiusForNode,
} from './blast.service';

type Direction = 'downstream' | 'upstream';

function parseDirection(value: string | undefined): Direction {
  const d = value ?? 'downstream';
  if (d !== 'downstream' && d !== 'upstream') {
    throw new BadRequestException(
      `direction must be 'downstream' or 'upstream', got '${value}'`,
    );
  }
  return d;
}

function parseMaxDepth(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new BadRequestException('maxDepth must be a positive integer');
  }
  return n;
}

@Controller()
export class AnalysisController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  @Get('branches/:branchId/blast/:entityId')
  async blastForNode(
    @Param('branchId') branchId: string,
    @Param('entityId') entityId: string,
    @Query('direction') direction?: string,
    @Query('maxDepth') maxDepth?: string,
  ): Promise<BlastRadius> {
    return blastRadiusForNode(
      this.db,
      branchId,
      entityId,
      parseDirection(direction),
      parseMaxDepth(maxDepth),
    );
  }

  @Get('blast/candidate')
  async blastForCandidate(
    @Query('base') base?: string,
    @Query('candidate') candidate?: string,
    @Query('direction') direction?: string,
  ): Promise<BlastRadius> {
    if (!base || !candidate) {
      throw new BadRequestException(
        'both `base` and `candidate` query params are required',
      );
    }
    return blastRadiusForCandidate(
      this.db,
      base,
      candidate,
      parseDirection(direction),
    );
  }
}
