import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { prepareApiDatabase } from './boot/bootstrap-db';

async function bootstrap(): Promise<void> {
  // In the compose stack the api is the SINGLE migrator: it applies migrations
  // and seeds the POC dataset once (idempotent on restart). Gated behind
  // BOOTSTRAP_DB so unit tests / ad-hoc local starts can opt out and manage the
  // DB themselves. The worker never runs this.
  if (process.env.BOOTSTRAP_DB === '1') {
    const result = await prepareApiDatabase();
    // eslint-disable-next-line no-console
    console.log(
      `DB ready (seed ${result.seed}: ${result.entities} entities, ${result.relations} relations)`,
    );
  }

  const app = await NestFactory.create(AppModule);
  app.enableCors();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const port = process.env.PORT ? Number(process.env.PORT) : 3001;
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`Archi-Graph API listening on :${port}`);
}

void bootstrap();
