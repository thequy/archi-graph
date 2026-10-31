// Unit tests for the markdown chunker (pure function — no DB, no LLM).
//
// Verifies the two behaviours the indexer relies on:
//   1. A ~2000-char document with several headings yields MULTIPLE chunks.
//   2. Chunking is HEADING-aware: each heading starts a chunk (a section's
//      heading is never buried in the middle of a previous chunk), and no
//      chunk text is lost.

import { describe, expect, it } from 'vitest';
import { chunkMarkdown, DEFAULT_CHUNK_SIZE } from './chunk';

/** Build a ~2000-char markdown doc with 4 headed sections. */
function bigDoc(): string {
  const para = (n: number): string =>
    `This is paragraph ${n}. ` + 'lorem ipsum dolor sit amet. '.repeat(10);
  return [
    '# Section One',
    para(1),
    para(2),
    '## Section Two',
    para(3),
    para(4),
    '## Section Three',
    para(5),
    para(6),
    '# Section Four',
    para(7),
    para(8),
  ].join('\n\n');
}

describe('chunkMarkdown', () => {
  it('a ~2000-char doc with headings yields multiple chunks', () => {
    const doc = bigDoc();
    expect(doc.length).toBeGreaterThan(1800);

    const chunks = chunkMarkdown(doc);
    expect(chunks.length).toBeGreaterThan(1);

    // 0-based contiguous indices.
    expect(chunks.map((c) => c.index)).toEqual(
      chunks.map((_, i) => i),
    );
  });

  it('preserves heading boundaries: each heading begins a chunk', () => {
    const doc = bigDoc();
    const chunks = chunkMarkdown(doc);

    const headings = [
      '# Section One',
      '## Section Two',
      '## Section Three',
      '# Section Four',
    ];

    for (const h of headings) {
      // The heading must appear at the START of some chunk, never mid-chunk.
      const startsAChunk = chunks.some((c) => c.text.startsWith(h));
      expect(startsAChunk, `heading should start a chunk: ${h}`).toBe(true);

      // And it must not appear in the interior of a chunk (i.e. preceded by
      // other text within the same chunk).
      for (const c of chunks) {
        if (c.text.startsWith(h)) continue;
        expect(
          c.text.includes(`\n${h}`),
          `heading must not be buried mid-chunk: ${h}`,
        ).toBe(false);
      }
    }
  });

  it('no content is dropped (every source paragraph survives)', () => {
    const doc = bigDoc();
    const chunks = chunkMarkdown(doc);
    const joined = chunks.map((c) => c.text).join('\n\n');
    expect(joined).toContain('This is paragraph 1.');
    expect(joined).toContain('This is paragraph 8.');
  });

  it('respects the soft target size for packed blocks', () => {
    const chunks = chunkMarkdown(bigDoc());
    // Every chunk either is a single block or fits under the target.
    for (const c of chunks) {
      const isSingleBlock = !c.text.includes('\n\n');
      expect(isSingleBlock || c.text.length <= DEFAULT_CHUNK_SIZE).toBe(true);
    }
  });

  it('empty input yields no chunks', () => {
    expect(chunkMarkdown('')).toEqual([]);
    expect(chunkMarkdown('   \n\n  ')).toEqual([]);
  });
});
