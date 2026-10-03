import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyRequest } from 'fastify';
import { ACCEPTED_MIME_TYPES, type Config } from '../config.js';
import { UPLOAD_SCRATCH_DIRECTORY, UPLOAD_SCRATCH_SUFFIX } from '../storage/retention.js';
import { AppError } from './errors.js';
import { streamToScratch, type ScratchUpload } from './upload.js';

export interface ReceivedUpload extends ScratchUpload {
  /** The name the browser gave the file (unsanitised: see `sanitizeDisplayFilename`). */
  filename: string;
}

/**
 * Reads the multipart body of an upload to the end: exactly one file in the field `file` (a second file, a flood of fields
 * and a field declared as JSON that is not JSON are refused by the multipart plugin when the iteration reaches them, so
 * they are caught deterministically, never skipped), ending in `.pdf`, with a PDF or octet-stream content type, streamed
 * to a scratch file. The checks of the file itself (not empty, `%PDF-` within the first 1024 bytes, structure) are the
 * same for every kind of upload: see accept-upload.ts. The caller removes the scratch file when it is done; on a failure
 * it is already gone.
 */
export async function receiveUpload(request: FastifyRequest, config: Config): Promise<ReceivedUpload> {
  let received: ReceivedUpload | undefined;
  try {
    for await (const part of request.parts()) {
      if (part.type !== 'file') continue; // form fields are never read
      const discard = (): void => {
        part.file.resume();
      };
      if (received !== undefined) {
        discard();
        throw new AppError(
          'FILE_TOO_LARGE',
          'Too many files were uploaded; send exactly one PDF.',
          'a second file was sent',
        );
      }
      if (part.fieldname !== 'file') {
        discard();
        throw new AppError(
          'FILE_MISSING',
          'The PDF must be sent in a multipart field named "file".',
          `the field was named "${part.fieldname.slice(0, 40)}"`,
        );
      }
      if (!/\.pdf$/iu.test(part.filename)) {
        discard();
        throw new AppError('FILE_NOT_PDF', 'The file name must end in .pdf.');
      }
      const declared = part.mimetype.split(';')[0]?.trim().toLowerCase() ?? '';
      // application/octet-stream is what some browsers send for a PDF: accepted, but only with a valid PDF header.
      if (
        !(ACCEPTED_MIME_TYPES as readonly string[]).includes(declared) &&
        declared !== 'application/octet-stream'
      ) {
        discard();
        throw new AppError(
          'FILE_NOT_PDF',
          'The file is not a PDF.',
          `unsupported content type "${declared.slice(0, 60)}"`,
        );
      }
      const scratch = await streamToScratch(
        part.file,
        path.join(config.tmpDir, UPLOAD_SCRATCH_DIRECTORY),
        `${randomUUID()}${UPLOAD_SCRATCH_SUFFIX}`,
        config.maxUploadBytes,
      );
      received = { ...scratch, filename: part.filename };
      if (part.file.truncated) {
        throw new AppError('FILE_TOO_LARGE', 'The file is larger than the maximum upload size.');
      }
    }
    if (received === undefined) {
      throw new AppError(
        'FILE_MISSING',
        'No file was uploaded; send one PDF in a multipart field named "file".',
      );
    }
    return received;
  } catch (error) {
    if (received !== undefined) await rm(received.path, { force: true });
    throw error;
  }
}
