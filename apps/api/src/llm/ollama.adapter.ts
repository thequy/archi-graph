// OllamaAdapter — the concrete LlmPort backed by a local Ollama server.
//
// Talks HTTP to OLLAMA_URL (default http://localhost:11434) using the standard
// Ollama REST API:
//   - embeddings : POST /api/embeddings  { model, prompt } -> { embedding }
//   - generation : POST /api/generate    { model, prompt, stream:false } -> { response }
//
// Models (overridable via env):
//   EMBED_MODEL = nomic-embed-text   (produces 768-dim vectors)
//   GEN_MODEL   = llama3.1
//
// Embeddings are ASSERTED to be EMBED_DIM (768) so a model/config mismatch
// fails loudly here rather than silently corrupting doc_chunks.embedding
// (which is vector(768)).
//
// NOTE: there is NO live Ollama in the unit tests — tests inject a deterministic
// mock LlmPort. This class is exercised for real only in the compose task
// (Task 12). It is written to be correct and self-validating, not test-covered
// against a live server here.

import { Injectable } from '@nestjs/common';
import { EMBED_DIM, type LlmPort } from './llm.port';

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_EMBED_MODEL = 'nomic-embed-text';
const DEFAULT_GEN_MODEL = 'llama3.1';

export interface OllamaAdapterOptions {
  baseUrl?: string;
  embedModel?: string;
  genModel?: string;
  /** Injectable fetch for testability; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

@Injectable()
export class OllamaAdapter implements LlmPort {
  private readonly baseUrl: string;
  private readonly embedModel: string;
  private readonly genModel: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OllamaAdapterOptions = {}) {
    this.baseUrl = (
      opts.baseUrl ??
      process.env.OLLAMA_URL ??
      DEFAULT_OLLAMA_URL
    ).replace(/\/$/, '');
    this.embedModel =
      opts.embedModel ?? process.env.EMBED_MODEL ?? DEFAULT_EMBED_MODEL;
    this.genModel =
      opts.genModel ?? process.env.GEN_MODEL ?? DEFAULT_GEN_MODEL;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async embed(texts: string[]): Promise<number[][]> {
    // Ollama's /api/embeddings takes a single prompt per call; embed each text
    // in order and validate the dimension of every returned vector.
    const vectors: number[][] = [];
    for (const text of texts) {
      const res = await this.fetchImpl(`${this.baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.embedModel, prompt: text }),
      });
      if (!res.ok) {
        throw new Error(
          `ollama embeddings failed: ${res.status} ${res.statusText}`,
        );
      }
      const body = (await res.json()) as { embedding?: number[] };
      const embedding = body.embedding;
      if (!Array.isArray(embedding)) {
        throw new Error('ollama embeddings: missing `embedding` array');
      }
      if (embedding.length !== EMBED_DIM) {
        throw new Error(
          `ollama embeddings: expected ${EMBED_DIM}-dim vector, got ${embedding.length} ` +
            `(model=${this.embedModel}) — doc_chunks.embedding is vector(${EMBED_DIM})`,
        );
      }
      vectors.push(embedding);
    }
    return vectors;
  }

  async complete(prompt: string, context: string[]): Promise<string> {
    // Fold the retrieved context into the prompt. The context chunks are the
    // grounding sources; the generation model answers using them.
    const contextBlock =
      context.length > 0
        ? `Context:\n${context.map((c, i) => `[${i + 1}] ${c}`).join('\n\n')}\n\n`
        : '';
    const fullPrompt = `${contextBlock}${prompt}`;

    const res = await this.fetchImpl(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.genModel,
        prompt: fullPrompt,
        stream: false,
      }),
    });
    if (!res.ok) {
      throw new Error(
        `ollama generate failed: ${res.status} ${res.statusText}`,
      );
    }
    const body = (await res.json()) as { response?: string };
    return body.response ?? '';
  }
}
