// Unit tests for extractText (Slice C — Ingest, Task 8).
//
// Pure text-extraction, NO DB and NO LLM — so these run fast and do not touch
// Postgres. Exercises each supported mime path against a committed fixture:
//   - .md / plain text : read the file straight through.
//   - .docx            : mammoth.extractRawText.
//   - .pdf             : pdf-parse.
// And the FAILURE contract the ingest service relies on to mark a file
// 'failed' instead of looping forever: an empty file and a garbage/undecodable
// file both throw a CLASSIFIED ExtractError (name === 'ExtractError').

import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractText, ExtractError } from './extract';

const FIXTURES = join(__dirname, '__fixtures__');

describe('extractText', () => {
  it('reads a .md / text file verbatim', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ingest-extract-md-'));
    try {
      const p = join(dir, 'notes.md');
      const body = '# Title\n\nSome **markdown** body.\n';
      await writeFile(p, body, 'utf8');
      const text = await extractText(p, 'text/markdown');
      expect(text).toBe(body);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('extracts text from a .docx via mammoth', async () => {
    const text = await extractText(
      join(FIXTURES, 'sample.docx'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(text).toContain('Hello from a docx fixture.');
  });

  it('extracts text from a .pdf via pdf-parse', async () => {
    const text = await extractText(
      join(FIXTURES, 'sample.pdf'),
      'application/pdf',
    );
    expect(text).toContain('Hello from a pdf fixture.');
  });

  it('throws a classified ExtractError on an EMPTY file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ingest-extract-empty-'));
    try {
      const p = join(dir, 'empty.md');
      await writeFile(p, '', 'utf8');
      await expect(extractText(p, 'text/markdown')).rejects.toThrow(
        ExtractError,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws a classified ExtractError on a whitespace-only file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ingest-extract-ws-'));
    try {
      const p = join(dir, 'blank.md');
      await writeFile(p, '   \n\t  \n', 'utf8');
      await expect(extractText(p, 'text/markdown')).rejects.toThrow(
        ExtractError,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws a classified ExtractError on a garbage/undecodable PDF', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ingest-extract-garbage-'));
    try {
      const p = join(dir, 'garbage.pdf');
      await writeFile(p, Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]));
      const err = await extractText(p, 'application/pdf').catch((e) => e);
      expect(err).toBeInstanceOf(ExtractError);
      expect((err as ExtractError).name).toBe('ExtractError');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
