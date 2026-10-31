// NestJS module wiring the blast-radius analysis HTTP surface.
//
// The blast-radius functions (blast.service.ts) are plain, stateless functions
// over a Db — they are not NestJS providers. The controller injects the shared
// Db (DB_TOKEN) supplied by the @Global DatabaseModule and calls them directly.
// This module therefore only registers the controller; it re-declares no DB
// provider (the single DB_TOKEN contract lives in DatabaseModule).

import { Module } from '@nestjs/common';
import { AnalysisController } from './analysis.controller';

@Module({
  controllers: [AnalysisController],
})
export class AnalysisModule {}
