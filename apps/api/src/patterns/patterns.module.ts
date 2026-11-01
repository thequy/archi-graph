// NestJS module wiring the GLOBAL pattern catalog surface.
//
// Relies on the shared Db provider token (DB_TOKEN) supplied by the @Global
// DatabaseModule so the whole app shares one Drizzle instance. PatternService
// takes a plain Db in its constructor (trivially unit-testable with
// `new PatternService(db)`) and is constructed here through DI via the same
// provider-factory pattern as ProjectsModule / ModelModule.

import { Module } from '@nestjs/common';
import { type Db } from '../db/client';
import { DB_TOKEN } from '../model/tokens';
import { PatternService } from './pattern.service';
import { PatternsController } from './patterns.controller';

@Module({
  controllers: [PatternsController],
  providers: [
    {
      provide: PatternService,
      useFactory: (db: Db): PatternService => new PatternService(db),
      inject: [DB_TOKEN],
    },
  ],
  exports: [PatternService],
})
export class PatternsModule {}
