// Minimal ambient declaration for pdf-parse (Slice C — Ingest, Task 8).
//
// The repo pins NO @types/pdf-parse (lean, local-first deps). We import the
// library's pure internal parser `pdf-parse/lib/pdf-parse.js` (see extract.ts
// for why NOT the package main). Declare exactly the surface we use so `tsc`
// is satisfied under `strict`; the runtime object comes from the real package.

declare module 'pdf-parse/lib/pdf-parse.js' {
  /** Parsed-PDF result; we only read `.text` (the extracted text layer). */
  interface PdfParseResult {
    text: string;
    numpages: number;
    info: unknown;
    metadata: unknown;
    version: string;
  }
  /** Parse a PDF buffer and return its extracted text (+ metadata). */
  function pdfParse(dataBuffer: Buffer): Promise<PdfParseResult>;
  export = pdfParse;
}
