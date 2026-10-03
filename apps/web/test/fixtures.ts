import type { DocumentDetail } from '@enchanted/shared';
import type { UiError } from '../src/api/client';

export const DOCUMENT_ID = '3b6f1f0e-8a52-4d6b-9d0c-6f1f6d0b7e11';

/** A minimal valid DocumentDetail. */
export function makeDocument(overrides: Partial<DocumentDetail> = {}): DocumentDetail {
  return {
    id: DOCUMENT_ID,
    filename: 'manuscript.pdf',
    byteSize: 1234,
    pageCount: 5,
    status: 'ready',
    stage: 'ready',
    primaryLanguage: 'en',
    direction: 'ltr',
    createdAt: '2026-10-01T10:00:00.000Z',
    expiresAt: '2026-10-02T10:00:00.000Z',
    languages: [{ code: 'en', share: 1 }],
    pages: [],
    warnings: [],
    sections: [],
    chunkCount: 12,
    ...overrides,
  };
}

export const SOME_ERROR: UiError = { code: 'PDF_MALFORMED', message: 'bad xref table' };

export function makeFile(name = 'manuscript.pdf'): File {
  return new File(['%PDF-1.7'], name, { type: 'application/pdf' });
}
