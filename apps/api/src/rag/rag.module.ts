// NestJS module wiring the RAG feature.
//
// Providers:
//   - LLM_TOKEN -> OllamaAdapter (the default, real backend). Unit tests
//     override this binding with a deterministic mock LlmPort, which is the
//     whole reason the port is injected through a token rather than newed up
//     inside the services.
//   - IndexerService / RagService are constructed through DI from the shared
//     Db (DB_TOKEN, @Global DatabaseModule) plus the LlmPort. They also accept
//     a plain (db, llm) constructor so a test can `new RagService(db, mock)`.
//
// The controller exposes POST /branches/:branchId/ask. The background indexer
// LOOP (interval) is wired by the compose task (Task 12); here IndexerService
// is just provided/exported so it can be driven directly.

import { Module } from '@nestjs/common';
import { type Db } from '../db/client';
import { DB_TOKEN } from '../model/tokens';
import { LLM_TOKEN, type LlmPort } from '../llm/llm.port';
import { OllamaAdapter } from '../llm/ollama.adapter';
import { IndexerService } from './indexer.service';
import { RagService } from './rag.service';
import { RagController } from './rag.controller';

@Module({
  controllers: [RagController],
  providers: [
    {
      provide: LLM_TOKEN,
      useFactory: (): LlmPort => new OllamaAdapter(),
    },
    {
      provide: RagService,
      useFactory: (db: Db, llm: LlmPort): RagService =>
        new RagService(db, llm),
      inject: [DB_TOKEN, LLM_TOKEN],
    },
    {
      provide: IndexerService,
      useFactory: (db: Db, llm: LlmPort): IndexerService =>
        new IndexerService(db, llm),
      inject: [DB_TOKEN, LLM_TOKEN],
    },
  ],
  exports: [RagService, IndexerService],
})
export class RagModule {}
