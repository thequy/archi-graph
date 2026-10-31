// Markdown chunker for the RAG indexer.
//
// Goal: split an entity's content_markdown into retrieval-sized chunks that
// stay semantically coherent. The strategy is HEADING- and PARAGRAPH-aware:
//
//   1. Split the document into blocks on blank lines (paragraph boundaries),
//      treating a markdown heading line (`#`, `##`, …) as the START of a new
//      block so a heading always attaches to the prose that follows it rather
//      than being merged into the previous section.
//   2. Greedily pack consecutive blocks into a chunk until adding the next
//      block would exceed the target size (~800 chars). A new chunk is also
//      forced to begin whenever a heading block is encountered and the current
//      chunk is non-empty — this PRESERVES HEADING BOUNDARIES (a section never
//      starts in the middle of a previous chunk).
//   3. A single block larger than the target size is emitted on its own (we do
//      not hard-split inside a paragraph; keeping the paragraph intact matters
//      more than the soft size cap).
//
// Returns chunks in document order with a 0-based `index` used as
// doc_chunks.chunk_index (part of the (entity_id, commit_id, chunk_index) key).

/** Default soft target chunk size in characters. */
export const DEFAULT_CHUNK_SIZE = 800;

export interface Chunk {
  index: number;
  text: string;
}

/** True for a markdown ATX heading line (`#` … `######`). */
function isHeading(block: string): boolean {
  return /^#{1,6}\s/.test(block.trimStart());
}

/**
 * Split markdown into heading/paragraph-aware chunks of ~targetSize chars.
 * @param text the entity content_markdown
 * @param targetSize soft max chunk size in characters (default ~800)
 */
export function chunkMarkdown(
  text: string,
  targetSize: number = DEFAULT_CHUNK_SIZE,
): Chunk[] {
  // Normalize line endings, then split into paragraph blocks on blank lines.
  const normalized = text.replace(/\r\n/g, '\n');
  const rawBlocks = normalized
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  const chunks: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current.trim().length > 0) {
      chunks.push(current.trim());
    }
    current = '';
  };

  for (const block of rawBlocks) {
    const heading = isHeading(block);

    // A heading forces a new chunk boundary (unless the current chunk is empty)
    // so that a section heading always begins a fresh chunk.
    if (heading && current.length > 0) {
      flush();
    }

    const candidate = current.length === 0 ? block : `${current}\n\n${block}`;

    if (candidate.length <= targetSize || current.length === 0) {
      // Fits, or the block alone already exceeds the target (emit it whole).
      current = candidate;
    } else {
      // Adding this block would overflow — close the current chunk and start a
      // new one with this block.
      flush();
      current = block;
    }
  }
  flush();

  return chunks.map((text, index) => ({ index, text }));
}
