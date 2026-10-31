// NestJS module wiring the commit engine.
//
// CommitService needs the Drizzle Db instance (DB_TOKEN), which is provided
// globally by DatabaseModule. We wire CommitService via a provider token so the
// service is constructed through Nest DI while still accepting a plain Db in its
// constructor (which keeps it trivially unit-testable with `new CommitService(db)`).

import { Module } from '@nestjs/common';
import { type Db } from '../db/client';
import { CommitService } from './commit.service';
import { ModelController } from './model.controller';
import { DB_TOKEN } from './tokens';

export { DB_TOKEN };

@Module({
  controllers: [ModelController],
  providers: [
    {
      provide: CommitService,
      useFactory: (db: Db): CommitService => new CommitService(db),
      inject: [DB_TOKEN],
    },
  ],
  exports: [CommitService],
})
export class ModelModule {}
