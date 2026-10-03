import type { DocumentDetail } from '@enchanted/shared';
import type { Queryable } from '../db/client.js';
import { toDocumentDetail, type DocumentRow } from '../db/repositories/documents.js';
import { chunksRepo } from '../db/repositories/chunks.js';
import { pagesRepo } from '../db/repositories/pages.js';

/**
 * The API shape of a document: its row plus its page infos and chunk count. Empty lists until it is ready (the pages and
 * chunks of a document that is still being embedded are stored, but not yet its to show).
 */
export async function loadDocumentDetail(q: Queryable, row: DocumentRow): Promise<DocumentDetail> {
  if (row.status !== 'ready') return toDocumentDetail(row, [], 0);
  const [pages, chunkCount] = await Promise.all([pagesRepo.infos(q, row.id), chunksRepo.count(q, row.id)]);
  return toDocumentDetail(row, pages, chunkCount);
}

/*
 * The hints (`AppError.detail`) the ingestion and the upload routes may put in front of a browser. Every one is a constant or a
 * sentence built from numbers of ours: nothing a provider, the database or the file system said ever reaches a client.
 */
export const DETAIL_TOOK_TOO_LONG = 'the document took too long to process';
export const DETAIL_RATE_LIMITED = 'rate limited';
export const DETAIL_ARCHIVE_BUSY = 'too many documents are waiting to be read';
export const DETAIL_ARCHIVE_FULL = 'the archive has used its budget for today';
export const DETAIL_NO_PDF_HEADER = 'it does not start with a %PDF- header';
export const DETAIL_NO_SUCH_BLOB = 'no such blob';
export const DETAIL_MULTIPART_REFUSED = 'a multipart upload is not accepted';
export const DETAIL_TICKET_TRIES = 'the upload ticket was tried too often';
export const DETAIL_TICKET_USED = 'the upload ticket was used already';
export const DETAIL_TICKET_REFUSED = 'the upload ticket is not valid for this session';
export const detailInterrupted = (ticks: number): string => `${String(ticks)} ticks in a row did not finish`;
export const detailTooLarge = (limitBytes: number): string => `limit is ${String(limitBytes)} bytes`;
