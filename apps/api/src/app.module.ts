import { Module } from '@nestjs/common';

/**
 * Root application module. Downstream tasks (commit engine, diff, merge,
 * blast-radius, RAG) register their feature modules here.
 */
@Module({
  imports: [],
  controllers: [],
  providers: [],
})
export class AppModule {}
