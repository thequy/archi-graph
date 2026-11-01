// NestJS module wiring the Projects CRUD surface.
//
// Relies on the shared Db provider token (DB_TOKEN) supplied by the @Global
// DatabaseModule so the whole app shares one Drizzle instance. ProjectService
// takes a plain Db in its constructor (trivially unit-testable with
// `new ProjectService(db)`) and is constructed here through DI via the same
// provider-factory pattern as ModelModule / VersioningModule.

import { Module } from '@nestjs/common';
import { type Db } from '../db/client';
import { DB_TOKEN } from '../model/tokens';
import { ProjectService } from './project.service';
import { ProjectsController } from './projects.controller';

@Module({
  controllers: [ProjectsController],
  providers: [
    {
      provide: ProjectService,
      useFactory: (db: Db): ProjectService => new ProjectService(db),
      inject: [DB_TOKEN],
    },
  ],
  exports: [ProjectService],
})
export class ProjectsModule {}
