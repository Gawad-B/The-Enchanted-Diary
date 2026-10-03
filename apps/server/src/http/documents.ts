import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import fastifyMultipart from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { documentsRepo, toDocumentSummary } from '../db/repositories/documents.js';
import { loadDocumentDetail } from '../ingest/detail.js';
import type { Ingestion } from '../ingest/index.js';
import { sanitizeDisplayFilename } from '../storage/filename.js';
import { StorageError } from '../storage/provider.js';
import { archiveBusy, createDocumentFor, validateScratchPdf } from './accept-upload.js';
import { documentIdOf, documentNotFound, ownedDocument } from './document-access.js';
import { AppError } from './errors.js';
import { uploadLimits } from './upload-limits.js';
import { receiveUpload } from './receive-upload.js';
import { createDocumentFromBlob } from './uploads.js';

/** Form fields besides the file are never read; a handful is tolerated, a flood is refused by the plugin. */
const MAX_FORM_FIELDS = 8;
const MAX_FORM_PARTS = 12;

export interface DocumentRouteDeps {
  db: Db;
  ingestion: Ingestion;
}

/**
 * Whether the request is a multipart upload, by its header: the multipart plugin only knows it after the body parser has run,
 * which is after the `onRequest` hooks (where the per-address upload limit counts, before any body is read).
 */
const isMultipart = (request: FastifyRequest): boolean =>
  (request.headers['content-type'] ?? '').toLowerCase().startsWith('multipart/');

/** Resolves when the stream has its first bytes (or has ended), rejects with the error it raised before that. */
function untilReadable(stream: Readable): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (error?: unknown): void => {
      stream.off('error', done);
      stream.off('readable', done);
      if (error === undefined) resolve();
      else reject(error instanceof Error ? error : new Error('the stored file could not be read'));
    };
    stream.once('error', done);
    stream.once('readable', () => {
      done();
    });
  });
}

export async function registerDocumentRoutes(
  app: FastifyInstance,
  config: Config,
  deps: DocumentRouteDeps,
): Promise<void> {
  const { db, ingestion } = deps;
  const limits = uploadLimits(app, config);

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: 1,
      fields: MAX_FORM_FIELDS,
      parts: MAX_FORM_PARTS,
      fieldSize: 4096,
    },
    throwFileSizeLimit: true,
  });

  // --- POST /api/documents: a multipart upload, or (Blob mode) the JSON that names the blob the browser uploaded ---
  app.post(
    '/api/documents',
    {
      // `upload`: here a 413/415 means "file too large / not a PDF". The upload limits count the multipart kind here; in
      // Blob mode the ticket is what is counted (see uploads.ts), so the JSON kind is not counted twice.
      config: { upload: true },
      onRequest: [(request, reply) => (isMultipart(request) ? limits.ip(request, reply) : Promise.resolve())],
      preHandler: [
        (request, reply) => (isMultipart(request) ? limits.session(request, reply) : Promise.resolve()),
      ],
    },
    async (request, reply) => {
      const cancel = new AbortController();
      const onClose = (): void => {
        if (!reply.raw.writableEnded) cancel.abort(new DOMException('The client went away', 'AbortError'));
      };
      reply.raw.once('close', onClose);
      try {
        if (!isMultipart(request)) {
          const document = await createDocumentFromBlob(
            config,
            { db, ingestion },
            { body: request.body, sessionId: request.sessionId },
            cancel.signal,
          );
          return await reply.status(202).send({ document });
        }

        // Refused before the body is read; a document of this session that is still waiting does not count (the upload replaces
        // it), and a visitor turned away for the archive's own reasons gets the hour's allowance back.
        await limits.refundingRefusals(request, async () => {
          if (await ingestion.isFull(request.sessionId)) throw archiveBusy();
        });
        const upload = await receiveUpload(request, config);
        try {
          const { pageCount } = await validateScratchPdf({ config, ingestion }, upload, cancel.signal);
          const id = randomUUID();
          const row = await limits.refundingRefusals(request, () =>
            createDocumentFor(
              { db, config, ingestion },
              {
                id,
                sessionId: request.sessionId,
                filename: sanitizeDisplayFilename(upload.filename),
                size: upload.size,
                sha256: upload.sha256,
                pageCount,
                storageKey: `${id}.pdf`,
                scratchPath: upload.path,
              },
            ),
          );
          // The scratch copy goes before the answer is sent (a client that looks at the disk when it has the answer finds it gone).
          await rm(upload.path, { force: true });
          return await reply.status(202).send({ document: toDocumentSummary(row) });
        } finally {
          await rm(upload.path, { force: true });
        }
      } finally {
        reply.raw.off('close', onClose);
      }
    },
  );

  // --- GET /api/documents/:id ---
  app.get('/api/documents/:id', async (request, reply) => {
    const row = await ownedDocument(db, config, request);
    void reply.header('Cache-Control', 'no-store');
    return loadDocumentDetail(db, row);
  });

  // --- GET /api/documents/:id/file ---
  app.get('/api/documents/:id/file', async (request, reply) => {
    const row = await ownedDocument(db, config, request);
    if (row.status !== 'ready') {
      throw new AppError(
        'DOCUMENT_NOT_READY',
        'The document is not ready yet.',
        `its status is ${row.status}`,
      );
    }
    // The read is counted against the document's reads of the day (a Blob store counts every open), then made: the size is the
    // one the document was stored with (a `head` as well would be a second operation), and the answer does not start until the
    // store has said whether the file is there.
    await ingestion.blobBudgets.requireFileRead(db, row.id);
    const stream = ingestion.storage.createReadStream(row.storage_key);
    try {
      await untilReadable(stream);
    } catch (error) {
      stream.destroy();
      if (error instanceof StorageError && error.kind === 'NOT_FOUND') {
        throw new AppError('DOCUMENT_NOT_FOUND', 'The stored file of this document is gone.');
      }
      if (error instanceof StorageError) {
        throw new AppError('STORAGE_FAILED', 'The document could not be read from storage just now.');
      }
      throw error;
    }
    void reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Length', row.byte_size)
      .header('Content-Disposition', 'inline; filename="document.pdf"')
      .header('Cache-Control', 'no-store')
      // The PDF is untrusted content: if it is ever opened as a page it runs in an empty sandbox.
      .header('Content-Security-Policy', 'sandbox');
    return reply.send(stream);
  });

  // --- DELETE /api/documents/:id ---
  app.delete('/api/documents/:id', async (request, reply) => {
    const id = documentIdOf(request);
    const row = await documentsRepo.findOwned(db, id, request.sessionId);
    if (row === null) throw documentNotFound();
    await ingestion.service.removeDocument(row.id);
    return reply.status(204).send();
  });
}
