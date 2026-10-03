import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Queryable } from '../db/client.js';
import { documentsRepo, type DocumentRow, type Retention } from '../db/repositories/documents.js';
import { AppError } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const documentNotFound = (): AppError =>
  new AppError('DOCUMENT_NOT_FOUND', 'No such document in this session.');

export function retentionOf(config: Config): Retention {
  return { hours: config.documentRetentionHours, maxHours: config.documentMaxRetentionHours };
}

/** The `:id` of a document route, or a 404 (a malformed id is a document that does not exist, never a 500). */
export function documentIdOf(request: FastifyRequest): string {
  const { id } = request.params as { id?: string };
  if (id === undefined || !UUID.test(id)) throw documentNotFound();
  return id.toLowerCase();
}

/** The session's document (not expired), after sliding its expiry; throws 404 for anyone else's. */
export async function ownedDocument(
  db: Queryable,
  config: Config,
  request: FastifyRequest,
): Promise<DocumentRow> {
  const id = documentIdOf(request);
  const row = await documentsRepo.findForSession(db, id, request.sessionId);
  if (row === null) throw documentNotFound();
  const expiresAt = await documentsRepo.touch(db, row.id, retentionOf(config));
  return expiresAt === null ? row : { ...row, expires_at: expiresAt };
}

/** Like `ownedDocument`, and the document must be ready to be questioned (409 DOCUMENT_NOT_READY otherwise). */
export async function readyDocument(
  db: Queryable,
  config: Config,
  request: FastifyRequest,
): Promise<DocumentRow> {
  const row = await ownedDocument(db, config, request);
  if (row.status !== 'ready') {
    throw new AppError('DOCUMENT_NOT_READY', 'The document is not ready yet.', `its status is ${row.status}`);
  }
  return row;
}
