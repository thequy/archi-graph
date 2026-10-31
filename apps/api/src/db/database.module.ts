// Global database module.
//
// Provides the single shared Drizzle Db instance (produced by getDb(), bound to
// DATABASE_URL) under DB_TOKEN. Marked @Global so every feature module (model,
// versioning, and future merge / blast-radius / RAG modules) can inject
// DB_TOKEN without re-declaring the provider. This is the ONE place the DB
// provider contract lives — avoids split-brain-DB risk from duplicated
// useFactory providers.
//
// The DB_TOKEN constant continues to live in model/tokens.ts (a standalone,
// cycle-free file) so existing imports of DB_TOKEN keep working unchanged.

import { Global, Module } from '@nestjs/common';
import { getDb, type Db } from './client';
import { DB_TOKEN } from '../model/tokens';

@Global()
@Module({
  providers: [
    {
      provide: DB_TOKEN,
      useFactory: (): Db => getDb(),
    },
  ],
  exports: [DB_TOKEN],
})
export class DatabaseModule {}
