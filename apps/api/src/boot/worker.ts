// Background embedding worker entry point.
//
// Runs IndexerService.runPending() on a fixed interval. This is the process the
// compose `worker` service executes. It:
//   1. WAITS for the schema to exist (waitForSchema) — it does NOT migrate and
//      does NOT seed. The api is the single migrator/seeder; the worker only
//      consumes the embedding_jobs the commit path enqueues. This is what
//      avoids the concurrent `CREATE EXTENSION` race.
//   2. Loops forever: each tick drains all pending work via the real
//      OllamaAdapter:
//        - IngestService.runPending() turns newly-uploaded files (summary_status
//          'pending') into summarized document entities on their project's main
//          (which in turn enqueues embedding_jobs); then
//        - IndexerService.runPending() embeds all pending embedding_jobs
//          (nomic-embed-text, 768-dim) and marks them done.
//      Ingest runs BEFORE indexing each tick so a file uploaded and summarized
//      in this tick also gets embedded in the same tick. Both are idempotent,
//      so a tick with no new work does 0.
//
// Env:
//   DATABASE_URL        Postgres connection (required)
//   OLLAMA_URL          Ollama base url (OllamaAdapter default localhost:11434)
//   EMBED_MODEL         defaults to nomic-embed-text
//   WORKER_INTERVAL_MS  poll cadence between drains (default 5000)

import 'reflect-metadata';
import { getDb } from '../db/client';
import { OllamaAdapter } from '../llm/ollama.adapter';
import { IndexerService } from '../rag/indexer.service';
import { IngestService } from '../ingest/ingest.service';
import { waitForSchema } from './bootstrap-db';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const intervalMs = process.env.WORKER_INTERVAL_MS
    ? Number(process.env.WORKER_INTERVAL_MS)
    : 5_000;

  // eslint-disable-next-line no-console
  console.log('worker: waiting for schema...');
  await waitForSchema();
  // eslint-disable-next-line no-console
  console.log('worker: schema present, starting ingest+indexing loop');

  const db = getDb();
  const llm = new OllamaAdapter();
  const ingest = new IngestService(db, llm);
  const indexer = new IndexerService(db, llm);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // Ingest first: new uploads -> summarized entities (+ embedding_jobs),
      // so a file uploaded this tick is embedded in the SAME tick below.
      const ingested = await ingest.runPending();
      if (ingested > 0) {
        // eslint-disable-next-line no-console
        console.log(`worker: ingested ${ingested} file(s)`);
      }
    } catch (err) {
      // A transient extraction/LLM/commit error must not kill the worker; the
      // next tick retries the still-pending files. (IngestService also marks a
      // per-file failure 'failed' internally, so this only catches surprises.)
      // eslint-disable-next-line no-console
      console.error('worker: ingest pass failed, will retry:', err);
    }

    try {
      const processed = await indexer.runPending();
      if (processed > 0) {
        // eslint-disable-next-line no-console
        console.log(`worker: indexed ${processed} job(s)`);
      }
    } catch (err) {
      // Log and keep looping — a transient Ollama/DB error must not kill the
      // worker; the next tick retries the still-pending jobs.
      // eslint-disable-next-line no-console
      console.error('worker: index pass failed, will retry:', err);
    }
    await sleep(intervalMs);
  }
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('worker: fatal:', err);
  process.exit(1);
});
