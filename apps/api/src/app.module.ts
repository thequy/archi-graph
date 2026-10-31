import { Module } from '@nestjs/common';
import { ModelModule } from './model/model.module';

/**
 * Root application module. Downstream tasks (diff, merge, blast-radius, RAG)
 * register their feature modules here. ModelModule provides the commit engine
 * and the entity/relation CRUD HTTP surface.
 */
@Module({
  imports: [ModelModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
