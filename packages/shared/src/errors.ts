/** Every error code the API can return. The order is not significant; the HTTP status lives in ERROR_HTTP_STATUS. */
export const ERROR_CODES = [
  'FILE_MISSING',
  'FILE_NOT_PDF',
  'FILE_TOO_LARGE',
  'TOO_MANY_PAGES',
  'PDF_ENCRYPTED',
  'PDF_MALFORMED',
  'PDF_EMPTY',
  'PDF_UNREADABLE',
  'DOCUMENT_NOT_FOUND',
  'DOCUMENT_NOT_READY',
  'QUESTION_INVALID',
  'RATE_LIMITED',
  'DIARY_BUSY',
  'LLM_UNAVAILABLE',
  'LLM_FAILED',
  'OUTPUT_BLOCKED',
  'EMBEDDING_FAILED',
  'INGEST_INTERRUPTED',
  'STORAGE_FAILED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  FILE_MISSING: 400,
  FILE_NOT_PDF: 415,
  FILE_TOO_LARGE: 413,
  TOO_MANY_PAGES: 422,
  PDF_ENCRYPTED: 422,
  PDF_MALFORMED: 422,
  PDF_EMPTY: 422,
  PDF_UNREADABLE: 422,
  DOCUMENT_NOT_FOUND: 404,
  DOCUMENT_NOT_READY: 409,
  QUESTION_INVALID: 400,
  RATE_LIMITED: 429,
  /** The local LLM is already generating an answer (single-flight). */
  DIARY_BUSY: 429,
  LLM_UNAVAILABLE: 503,
  LLM_FAILED: 502,
  OUTPUT_BLOCKED: 502,
  EMBEDDING_FAILED: 500,
  INGEST_INTERRUPTED: 500,
  STORAGE_FAILED: 500,
  INTERNAL: 500,
};

/** Non-fatal conditions attached to a document. */
export const WARNING_CODES = ['OCR_PARTIAL', 'OCR_UNAVAILABLE', 'LOW_TEXT_QUALITY'] as const;

export type WarningCode = (typeof WARNING_CODES)[number];
