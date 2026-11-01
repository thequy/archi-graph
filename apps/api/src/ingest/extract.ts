// Text extraction for uploaded source documents (Slice C — Ingest, Task 8).
//
// Turns an on-disk blob into plain text the LLM can summarize. One function,
// mime-dispatched:
//   - Word (.docx)      -> mammoth.extractRawText (strips OOXML formatting).
//   - PDF  (.pdf)       -> pdf-parse (pdf.js text layer).
//   - everything else   -> read the bytes as UTF-8 (covers .md / text/*). This
//                          is the safe default: the upload surface (Task 7)
//                          only accepts .md/.docx/.pdf, so a non-docx/non-pdf
//                          mime here is markdown/plain text.
//
// FAILURE CONTRACT (what the ingest service depends on):
//   extractText THROWS a *classified* `ExtractError` when
//     (a) the underlying parser throws (corrupt/garbage file), or
//     (b) extraction yields EMPTY/whitespace-only text (nothing to summarize).
//   The ingest loop catches ExtractError (indeed any error) per-file and marks
//   that file `summary_status='failed'` — it never leaves a file stuck
//   'pending' and never lets one bad file abort the whole drain.
//
// NOTE on the pdf-parse import: we import the library's INTERNAL
// `pdf-parse/lib/pdf-parse.js` rather than its package `main` (index.js). The
// published index.js contains a debug block that, when `module.parent` is
// falsy, tries to read a bundled test PDF off disk — harmless in a plain
// `require`, but a trap under bundlers/test runners. The lib entry is the pure
// parser with no such side effect.

import { readFile } from 'node:fs/promises';

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_MIME = 'application/pdf';

/**
 * Classified extraction failure. The ingest service matches on this (or any
 * thrown error) to mark a file 'failed' instead of leaving it 'pending'.
 * `cause` carries the original parser error (if any) for logging.
 */
export class ExtractError extends Error {
  constructor(
    message: string,
    public readonly reason: 'empty' | 'parse-failed',
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = 'ExtractError';
    if (options?.cause !== undefined) {
      // Attach the underlying error without relying on the ES2022 `cause`
      // option being present in the transpile target.
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * Extracts plain text from the blob at `path`, dispatching on `mime`.
 * Throws an ExtractError on parse failure or empty/whitespace-only content.
 */
export async function extractText(path: string, mime: string): Promise<string> {
  const normalized = (mime ?? '').toLowerCase().split(';')[0].trim();

  let text: string;
  if (normalized === DOCX_MIME) {
    text = await extractDocx(path);
  } else if (normalized === PDF_MIME) {
    text = await extractPdf(path);
  } else {
    // Default: markdown / plain text — read the bytes as UTF-8.
    text = await readFile(path, 'utf8');
  }

  if (text.trim().length === 0) {
    throw new ExtractError(
      `extracted empty content from ${path} (mime=${mime})`,
      'empty',
    );
  }
  return text;
}

async function extractDocx(path: string): Promise<string> {
  try {
    // mammoth is CommonJS; the default export carries extractRawText.
    const mammoth = (await import('mammoth')).default ?? (await import('mammoth'));
    const result = await mammoth.extractRawText({ path });
    return result.value;
  } catch (err) {
    throw new ExtractError(
      `failed to extract docx text from ${path}`,
      'parse-failed',
      { cause: err },
    );
  }
}

async function extractPdf(path: string): Promise<string> {
  try {
    // Import the pure parser (see file-header note on why NOT the package main).
    const mod = await import('pdf-parse/lib/pdf-parse.js');
    const pdf = (mod.default ?? mod) as (
      data: Buffer,
    ) => Promise<{ text: string }>;
    const buffer = await readFile(path);
    const result = await pdf(buffer);
    return result.text;
  } catch (err) {
    if (err instanceof ExtractError) throw err;
    throw new ExtractError(
      `failed to extract pdf text from ${path}`,
      'parse-failed',
      { cause: err },
    );
  }
}
