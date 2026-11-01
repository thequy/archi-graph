import { Module } from '@nestjs/common';
import { DatabaseModule } from './db/database.module';
import { ModelModule } from './model/model.module';
import { VersioningModule } from './versioning/versioning.module';
import { AnalysisModule } from './analysis/analysis.module';
import { RagModule } from './rag/rag.module';
import { ProjectsModule } from './projects/projects.module';
import { HealthController } from './health.controller';

/**
 * Root application module. DatabaseModule is a @Global provider of the one
 * shared Db (DB_TOKEN). ModelModule provides the commit engine and the
 * entity/relation CRUD HTTP surface; VersioningModule adds candidate branches
 * and the graph diff/merge endpoints; AnalysisModule adds the blast-radius
 * endpoints; RagModule adds the local RAG (indexer + ask) surface;
 * ProjectsModule adds the top-level Projects CRUD surface.
 */
@Module({
  imports: [
    DatabaseModule,
    ModelModule,
    VersioningModule,
    AnalysisModule,
    RagModule,
    ProjectsModule,
  ],
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}
