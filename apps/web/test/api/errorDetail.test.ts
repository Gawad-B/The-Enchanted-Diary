import { describe, expect, it } from 'vitest';
import { flavourOf, ticketIsGone } from '../../src/api/errorDetail';

describe("flavourOf: what an error's detail says (the server's phrases are those of apps/server/src/ingest/detail.ts)", () => {
  it.each([
    ['RATE_LIMITED', 'the archive has used its budget for today', 'archiveFull'],
    ['RATE_LIMITED', 'too many documents are waiting to be read', 'archiveBusy'],
    ['RATE_LIMITED', 'the upload ticket was tried too often', 'ticketTries'],
    ['RATE_LIMITED', 'retry after 42 minutes', 'rateLimit'],
    ['RATE_LIMITED', 'rate limited', null],
    ['RATE_LIMITED', undefined, null],
    ['FILE_MISSING', 'the upload ticket was used already', 'ticketUsed'],
    ['FILE_MISSING', 'the upload ticket is not valid for this session', 'ticketRefused'],
    ['FILE_MISSING', 'no such blob', 'noSuchBlob'],
    ['FILE_MISSING', undefined, null],
    ['FILE_NOT_PDF', 'name: notes.txt', 'notPdfName'],
    ['FILE_NOT_PDF', 'type: text/plain', 'notPdfType'],
    ['FILE_NOT_PDF', 'no %PDF- mark in the first kilobyte', 'notPdfHeader'],
    ['FILE_NOT_PDF', 'it does not start with a %PDF- header', 'notPdfHeader'], // the server's own wording
    ['PDF_ENCRYPTED', 'anything', null],
  ] as const)('%s + %j is %s', (code, detail, expected) => {
    expect(flavourOf({ code, detail })).toBe(expected);
  });

  it('a ticket that is spent, refused or worn out needs a new one; nothing else does', () => {
    expect(ticketIsGone({ code: 'FILE_MISSING', detail: 'the upload ticket was used already' })).toBe(true);
    expect(
      ticketIsGone({ code: 'FILE_MISSING', detail: 'the upload ticket is not valid for this session' }),
    ).toBe(true);
    expect(ticketIsGone({ code: 'RATE_LIMITED', detail: 'the upload ticket was tried too often' })).toBe(
      true,
    );
    expect(ticketIsGone({ code: 'FILE_MISSING', detail: 'no such blob' })).toBe(false);
    expect(ticketIsGone(new Error('x'))).toBe(false);
    expect(ticketIsGone(null)).toBe(false);
  });
});
