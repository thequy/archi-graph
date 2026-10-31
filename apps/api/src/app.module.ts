import { Module } from '@nestjs/common';
import { DatabaseModule } from './db/database.module';
import { ModelModule } from './model/model.module';
import { VersioningModule } from './versioning/versioning.module';

/**
 * Root application module. Downstream tasks (merge, blast-radius, RAG) register
 * their feature modules here. DatabaseModule is a @Global provider of the one
 * shared Db (DB_TOKEN). ModelModule provides the commit engine and the
 * entity/relation CRUD HTTP surface; VersioningModule adds candidate branches
 * and the graph diff endpoints.
 */
@Module({
  imports: [DatabaseModule, ModelModule, VersioningModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
