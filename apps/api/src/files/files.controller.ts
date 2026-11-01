// HTTP surface for Files (Slice C — Upload).
//
//   POST /projects/:projectId/files  (multipart, 1 file "file")
//         -> { fileId, summaryStatus: 'pending' }        (201)
//   GET  /files/:id/download          -> streams the stored blob
//   GET  /files/:id                   -> file metadata | 404
//
// FileInterceptor config — memoryStorage + our own write (see storage.ts):
//   * memoryStorage keeps the upload in a Buffer so we can enforce the size +
//     mime/extension whitelist BEFORE anything touches the disk (a rejected
//     upload leaves NO blob behind). The service then writes via the blob store.
//   * limits.fileSize = MAX_UPLOAD_BYTES (20 MB default). Multer aborts an
//     over-size stream and raises LIMIT_FILE_SIZE, which MulterExceptionFilter
//     maps to 413.
//   * fileFilter rejects anything whose mime/extension is not on the whitelist
//     (.pdf / .docx / .md) with a 400 — again before persistence.
//
// Upload is deliberately cheap: it validates, writes the blob, inserts a
// 'pending' row and returns. No text extraction / LLM here (Task 8 does that in
// the background). So the request returns promptly (Global Constraint).

import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { FilesService, type UploadedFileInput } from './files.service';
import { MulterExceptionFilter } from './multer-exception.filter';

/** Default maximum upload size: 20 MiB. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Accepted uploads: extension -> allowed mime(s). Only .pdf / .docx / .md pass;
 * everything else is rejected with a 400. A `.md` may arrive as text/markdown OR
 * text/plain (browsers/OSes disagree), so both are accepted for markdown.
 */
const ALLOWED: Record<string, string[]> = {
  '.pdf': ['application/pdf'],
  '.docx': [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  '.md': ['text/markdown', 'text/plain'],
};

function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

/**
 * True iff the (extension, mime) pair is on the whitelist. We require BOTH the
 * extension AND the mime to match a known entry so neither a spoofed extension
 * nor a spoofed content-type alone slips through.
 */
export function isAllowedUpload(filename: string, mime: string): boolean {
  const ext = extensionOf(filename);
  const mimes = ALLOWED[ext];
  if (!mimes) return false;
  return mimes.includes(mime.toLowerCase());
}

@Controller()
@UseFilters(MulterExceptionFilter)
export class FilesController {
  constructor(@Inject(FilesService) private readonly files: FilesService) {}

  @Post('projects/:projectId/files')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
      fileFilter: (_req, file, cb) => {
        if (isAllowedUpload(file.originalname, file.mimetype)) {
          cb(null, true);
        } else {
          // A BadRequestException raised here is surfaced by multer; the filter
          // maps it to a clean 400. No blob is written.
          cb(
            new BadRequestException(
              `unsupported file type: ${file.originalname} (${file.mimetype}); allowed: .pdf, .docx, .md`,
            ),
            false,
          );
        }
      },
    }),
  )
  async upload(
    // SECURITY: projectId becomes a path segment in the on-disk layout
    // (<DATA_DIR>/files/<projectId>/…). Validate it as a UUID BEFORE anything
    // touches the disk so a hostile value like `../../../../tmp/evil` is
    // rejected with a 400 up front — never used as an untrusted path segment.
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @UploadedFile() file: UploadedFileInput | undefined,
  ): Promise<{ fileId: string; summaryStatus: string }> {
    if (!file) {
      throw new BadRequestException('no file uploaded (field "file" required)');
    }
    const row = await this.files.save(projectId, file);
    return { fileId: row.id, summaryStatus: row.summaryStatus };
  }

  @Get('files/:id/download')
  async download(
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const opened = await this.files.openReadStream(id);
    if (!opened) {
      throw new NotFoundException(`file not found: ${id}`);
    }
    const { row, stream } = opened;
    res.setHeader('Content-Type', row.mime);
    res.setHeader('Content-Length', String(row.sizeBytes));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(row.filename)}"`,
    );
    stream.on('error', () => {
      if (!res.headersSent) res.status(500);
      res.end();
    });
    stream.pipe(res);
  }

  @Get('files/:id')
  async metadata(@Param('id') id: string): Promise<FileMetadata> {
    const row = await this.files.get(id);
    if (!row) {
      throw new NotFoundException(`file not found: ${id}`);
    }
    return {
      id: row.id,
      projectId: row.projectId,
      entityId: row.entityId,
      filename: row.filename,
      mime: row.mime,
      sizeBytes: row.sizeBytes,
      extractedChars: row.extractedChars,
      summaryStatus: row.summaryStatus,
      createdAt: row.createdAt,
    };
  }
}

/** Public metadata shape returned by GET /files/:id. */
export interface FileMetadata {
  id: string;
  projectId: string;
  entityId: string | null;
  filename: string;
  mime: string;
  sizeBytes: number;
  extractedChars: number | null;
  summaryStatus: string;
  createdAt: Date;
}
