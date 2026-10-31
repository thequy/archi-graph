// NestJS module wiring the branch/diff feature.
//
// Reuses the shared Db provider token (DB_TOKEN) exported by ModelModule so the
// whole app shares one Drizzle instance. BranchService takes a plain Db in its
// constructor (trivially unit-testable with `new BranchService(db)`) and is
// constructed here through DI.

import { Module } from '@nestjs/common';
import { getDb, type Db } from '../db/client';
import { DB_TOKEN } from '../model/tokens';
import { BranchService } from './branch.service';
import { VersioningController } from './versioning.controller';

@Module({
  controllers: [VersioningController],
  providers: [
    {
      provide: DB_TOKEN,
      useFactory: (): Db => getDb(),
    },
    {
      provide: BranchService,
      useFactory: (db: Db): BranchService => new BranchService(db),
      inject: [DB_TOKEN],
    },
  ],
  exports: [BranchService, DB_TOKEN],
})
export class VersioningModule {}
