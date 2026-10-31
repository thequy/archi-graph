// NestJS module wiring the commit engine.
//
// CommitService needs the Drizzle Db instance, which is produced by getDb()
// (bound to DATABASE_URL). We expose it via a provider token so the service is
// constructed through Nest DI while still accepting a plain Db in its
// constructor (which keeps it trivially unit-testable with `new CommitService(db)`).

import { Module } from '@nestjs/common';
import { getDb, type Db } from '../db/client';
import { CommitService } from './commit.service';

export const DB_TOKEN = 'ARCHI_GRAPH_DB';

@Module({
  providers: [
    {
      provide: DB_TOKEN,
      useFactory: (): Db => getDb(),
    },
    {
      provide: CommitService,
      useFactory: (db: Db): CommitService => new CommitService(db),
      inject: [DB_TOKEN],
    },
  ],
  exports: [CommitService, DB_TOKEN],
})
export class ModelModule {}
