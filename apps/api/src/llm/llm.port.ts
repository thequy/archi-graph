// LlmPort — the narrow boundary between the RAG feature and any concrete LLM
// backend (Ollama in prod; a deterministic mock in tests).
//
// Keeping the port this small (just embed + complete) means:
//   - IndexerService and RagService depend only on this interface, never on
//     HTTP / Ollama specifics;
//   - unit tests substitute a deterministic implementation (see
//     rag.service.test.ts) so similarity ranking is predictable and no live
//     Ollama is required;
//   - the real OllamaAdapter (ollama.adapter.ts) is exercised for real only in
//     the compose task (Task 12).
//
// Contract:
//   embed(texts)   -> one embedding vector per input text, SAME order.
//                     Every vector is EMBED_DIM (768) numbers (the fixed
//                     dimension of doc_chunks.embedding = vector(768)).
//   complete(p, c) -> a single generated answer string given a prompt and a
//                     list of context strings (the retrieved chunks).

/** Fixed embedding dimension — matches doc_chunks.embedding = vector(768). */
export const EMBED_DIM = 768;

/** DI token for the LlmPort binding (default = OllamaAdapter; tests override). */
export const LLM_TOKEN = 'ARCHI_GRAPH_LLM';

export interface LlmPort {
  /** Embed each input text; returns one EMBED_DIM-length vector per text, in order. */
  embed(texts: string[]): Promise<number[][]>;

  /** Generate an answer from a prompt plus retrieved context chunks. */
  complete(prompt: string, context: string[]): Promise<string>;
}
