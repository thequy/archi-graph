// Minimal ambient type declarations for the slices of `express` and `multer`
// the Files controller/filter touch.
//
// `@nestjs/platform-express` bundles both packages at runtime, but the repo
// pins NO @types/express / @types/multer (local-first, lean deps). Rather than
// add drifting dev-dependencies just to type two imports, we declare exactly
// the surface we use. The runtime objects come from the real packages; these
// declarations only satisfy `tsc` under `strict`.

declare module 'express' {
  /** The subset of the Express response we use when streaming a download.
   * Extends Node's WritableStream so `stream.pipe(res)` type-checks. */
  export interface Response extends NodeJS.WritableStream {
    headersSent: boolean;
    setHeader(name: string, value: string): void;
    status(code: number): Response;
    json(body: unknown): Response;
  }
}

declare module 'multer' {
  /** A single uploaded file as produced by multer's memoryStorage. */
  export interface MulterFile {
    fieldname: string;
    originalname: string;
    encoding: string;
    mimetype: string;
    size: number;
    buffer: Buffer;
  }

  /** multer's storage-engine handle. We only pass it through to Nest. */
  export interface StorageEngine {
    _handleFile: unknown;
    _removeFile: unknown;
  }

  /** In-memory storage engine factory (keeps the upload as a Buffer). */
  export function memoryStorage(): StorageEngine;

  /** The error multer throws for limit violations (e.g. LIMIT_FILE_SIZE). */
  export class MulterError extends Error {
    code: string;
    field?: string;
    constructor(code: string, field?: string);
  }
}
