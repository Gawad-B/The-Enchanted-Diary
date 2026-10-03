import type { UiError } from './client';

/*
 * What an error's `detail` says, as a short list of kinds. One code (RATE_LIMITED, FILE_MISSING, FILE_NOT_PDF) covers several
 * different things, and the diary says a different thing for each. The server's phrases are the constants of
 * apps/server/src/ingest/detail.ts; the client's own are the ones state/validateFile.ts writes (CLIENT_REASON). A phrase that
 * is not recognised (a reworded detail, a proxy) is simply a plain error of its code: matching is by key words so that a small
 * rewording still lands.
 */

/** What the browser's own checks put in front of their detail, so the line can name the real reason. */
export const CLIENT_REASON = {
  name: 'name: ',
  type: 'type: ',
  header: 'no %PDF- mark',
} as const;

export type ErrorFlavour =
  /** The Blob store's budget for the day is spent: nothing more is taken until tomorrow. */
  | 'archiveFull'
  /** The line of documents waiting to be read is full: a place comes free in a little while. */
  | 'archiveBusy'
  /** A rate limit of the visitor's own (per hour, per minute): the server says how long. */
  | 'rateLimit'
  /** The upload ticket was used, is not valid for this session, or was asked about too often: a new one is needed. */
  | 'ticketUsed'
  | 'ticketRefused'
  | 'ticketTries'
  /** The file never arrived in the store. */
  | 'noSuchBlob'
  | 'notPdfName'
  | 'notPdfType'
  | 'notPdfHeader';

type Described = Pick<UiError, 'code' | 'detail'>;

/** The kind of an error, or null for a plain one. */
export function flavourOf(error: Described): ErrorFlavour | null {
  const detail = error.detail ?? '';
  switch (error.code) {
    case 'RATE_LIMITED':
      if (/budget for today|full for today/iu.test(detail)) return 'archiveFull';
      if (/waiting to be read/iu.test(detail)) return 'archiveBusy';
      if (/tried too often/iu.test(detail)) return 'ticketTries';
      if (/^retry after\b/iu.test(detail)) return 'rateLimit';
      return null;
    case 'FILE_MISSING':
      if (/used already/iu.test(detail)) return 'ticketUsed';
      if (/not valid for this session/iu.test(detail)) return 'ticketRefused';
      if (/no such blob/iu.test(detail)) return 'noSuchBlob';
      return null;
    case 'FILE_NOT_PDF':
      if (detail.startsWith(CLIENT_REASON.name)) return 'notPdfName';
      if (detail.startsWith(CLIENT_REASON.type)) return 'notPdfType';
      if (/%PDF- (mark|header)/iu.test(detail)) return 'notPdfHeader';
      return null;
    default:
      return null;
  }
}

/** Whether the upload ticket is spent, refused or worn out: only a new one (and a new put) can go on. */
export function ticketIsGone(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const flavour = flavourOf(error as Described);
  return flavour === 'ticketUsed' || flavour === 'ticketRefused' || flavour === 'ticketTries';
}
