// NestJS module wiring the branch/diff feature.
//
// Relies on the shared Db provider token (DB_TOKEN) supplied by the @Global
// DatabaseModule so the whole app shares one Drizzle instance. BranchService
// takes a plain Db in its constructor (trivially unit-testable with
// `new BranchService(db)`) and is constructed here through DI.

import { Module } from '@nestjs/common';
import { type Db } from '../db/client';
import { DB_TOKEN } from '../model/tokens';
import { BranchService } from './branch.service';
import { VersioningController } from './versioning.controller';

@Module({
  controllers: [VersioningController],
  providers: [
    {
      provide: BranchService,
      useFactory: (db: Db): BranchService => new BranchService(db),
      inject: [DB_TOKEN],
    },
  ],
  exports: [BranchService],
})
export class VersioningModule {}
