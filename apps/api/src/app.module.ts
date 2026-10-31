import { Module } from '@nestjs/common';
import { ModelModule } from './model/model.module';
import { VersioningModule } from './versioning/versioning.module';

/**
 * Root application module. Downstream tasks (merge, blast-radius, RAG) register
 * their feature modules here. ModelModule provides the commit engine and the
 * entity/relation CRUD HTTP surface; VersioningModule adds candidate branches
 * and the graph diff endpoints.
 */
@Module({
  imports: [ModelModule, VersioningModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
