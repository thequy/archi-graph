// HTTP surface for RAG question-answering.
//
//   POST /branches/:branchId/ask   body { question }   -> RagAnswer
//
// An empty / un-indexed branch returns 200 with
// { answer: '<no indexed content>', citations: [] } (handled in RagService),
// NOT an error — so a fresh branch with nothing indexed is a normal success.

import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
} from '@nestjs/common';
import { IsString, MinLength } from 'class-validator';
import type { RagAnswer } from '@archi-graph/shared';
import { RagService } from './rag.service';

export class AskDto {
  @IsString()
  @MinLength(1)
  question!: string;
}

@Controller()
export class RagController {
  constructor(private readonly rag: RagService) {}

  @Post('branches/:branchId/ask')
  async ask(
    @Param('branchId') branchId: string,
    @Body() body: AskDto,
  ): Promise<RagAnswer> {
    if (!body || typeof body.question !== 'string') {
      throw new BadRequestException('`question` (string) is required');
    }
    return this.rag.query(branchId, body.question);
  }
}
