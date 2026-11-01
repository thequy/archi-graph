// Maps multer upload errors to clean HTTP responses on the Files controller.
//
//   * LIMIT_FILE_SIZE (over the 20 MB cap) -> 413 Payload Too Large.
//   * A BadRequestException raised inside the multer fileFilter (unsupported
//     file type) -> 400, passed through unchanged.
//
// Without this filter multer's MulterError would surface as an unhandled 500.
// Either way the request is rejected BEFORE the service writes anything, so a
// rejected upload leaves no `files` row and no blob on disk.

import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { MulterError } from 'multer';

@Catch(MulterError, BadRequestException, HttpException)
export class MulterExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof MulterError) {
      const status =
        exception.code === 'LIMIT_FILE_SIZE'
          ? HttpStatus.PAYLOAD_TOO_LARGE
          : HttpStatus.BAD_REQUEST;
      res.status(status).json({
        statusCode: status,
        message:
          exception.code === 'LIMIT_FILE_SIZE'
            ? 'file exceeds the maximum allowed size'
            : exception.message,
        error: exception.code,
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      res.status(status).json(exception.getResponse());
      return;
    }

    // Defensive fallback — should not happen given @Catch above.
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'upload failed',
    });
  }
}
