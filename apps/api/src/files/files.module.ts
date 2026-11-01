// NestJS module wiring the Files upload/download surface (Slice C — Upload).
//
// Mirrors the ProjectsModule provider-factory pattern: the shared Db comes from
// the @Global DatabaseModule (DB_TOKEN); the filesystem blob store is provided
// under STORAGE_TOKEN (rooted at DATA_DIR, env, default ./data). FilesService
// takes a plain (Db, BlobStore) pair so it is trivially unit-testable, and is
// constructed here via DI. The controller is thin.

import { Module } from '@nestjs/common';
import { type Db } from '../db/client';
import { DB_TOKEN } from '../model/tokens';
import { STORAGE_TOKEN } from './tokens';
import { createStorage, type BlobStore } from './storage';
import { FilesService } from './files.service';
import { FilesController } from './files.controller';

@Module({
  controllers: [FilesController],
  providers: [
    {
      provide: STORAGE_TOKEN,
      // DATA_DIR is read at construction (createStorage -> resolveDataDir).
      useFactory: (): BlobStore => createStorage(),
    },
    {
      provide: FilesService,
      useFactory: (db: Db, storage: BlobStore): FilesService =>
        new FilesService(db, storage),
      inject: [DB_TOKEN, STORAGE_TOKEN],
    },
  ],
  exports: [FilesService, STORAGE_TOKEN],
})
export class FilesModule {}
