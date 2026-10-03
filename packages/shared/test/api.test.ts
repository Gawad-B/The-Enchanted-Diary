import { describe, expect, it } from 'vitest';
import {
  AnswerStreamEventSchema,
  ApiErrorSchema,
  AskRequestSchema,
  CitationSchema,
  ConversationSchema,
  DocumentDetailSchema,
  DocumentSummarySchema,
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  HealthSchema,
  CreateDocumentFromBlobSchema,
  CreateDocumentResponseSchema,
  IngestTickResponseSchema,
  MessageSchema,
  NormalizedRectSchema,
  PageInfoSchema,
  ProgressEventSchema,
  PublicConfigSchema,
  QUESTION_MAX_CHARS,
  RevealRequestSchema,
  SessionDocumentResponseSchema,
  UploadTicketSchema,
  WARNING_CODES,
} from '../src/index.js';

const DOC_ID = '3b6f1f0e-8a52-4d6b-9d0c-6f1f6d0b7e11';
const CHUNK_ID = '0c9b1e52-4a0b-4f0f-b9f6-2f1d5c3a9e77';
const NOW = '2026-10-01T10:00:00.000Z';

const summary = {
  id: DOC_ID,
  filename: 'manuscript.pdf',
  byteSize: 1234,
  pageCount: 5,
  status: 'ready' as const,
  stage: 'ready' as const,
  primaryLanguage: 'en',
  direction: 'ltr' as const,
  createdAt: NOW,
  expiresAt: '2026-10-02T10:00:00.000Z',
};

const page = {
  pageNumber: 1,
  width: 595.2,
  height: 841.9,
  language: 'en',
  direction: 'ltr' as const,
  extraction: 'text' as const,
  charCount: 812,
  ocrConfidence: null,
};

const detail = {
  ...summary,
  languages: [{ code: 'en', share: 1 }],
  pages: [page, { ...page, pageNumber: 2, extraction: 'ocr' as const, ocrConfidence: 81.5 }],
  warnings: [{ code: 'OCR_PARTIAL' as const, pages: [2] }],
  sections: [{ title: 'The Founding', page: 2 }],
  chunkCount: 12,
};

const citation = {
  marker: 'S1',
  chunkId: CHUNK_ID,
  pageStart: 2,
  pageEnd: 3,
  sectionTitle: 'The Founding',
  snippet: 'Alaric Thornquist founded the archive on 14 March 1847.',
  language: 'en',
  direction: 'ltr' as const,
  highlights: [{ page: 2, rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.04 }] }],
};

describe('error codes', () => {
  it('has an HTTP status for every code and exactly the documented codes', () => {
    expect(ERROR_CODES).toHaveLength(20);
    for (const code of ERROR_CODES) expect(ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
    expect(Object.keys(ERROR_HTTP_STATUS).sort()).toEqual([...ERROR_CODES].sort());
  });

  it('uses the documented statuses', () => {
    expect(ERROR_HTTP_STATUS).toMatchObject({
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
      DIARY_BUSY: 429,
      LLM_UNAVAILABLE: 503,
      LLM_FAILED: 502,
      OUTPUT_BLOCKED: 502,
      EMBEDDING_FAILED: 500,
      INGEST_INTERRUPTED: 500,
      STORAGE_FAILED: 500,
      INTERNAL: 500,
    });
  });

  it('has the three warning codes', () => {
    expect([...WARNING_CODES]).toEqual(['OCR_PARTIAL', 'OCR_UNAVAILABLE', 'LOW_TEXT_QUALITY']);
  });
});

describe('ApiErrorSchema', () => {
  it('parses an error with and without detail', () => {
    expect(ApiErrorSchema.parse({ error: { code: 'PDF_ENCRYPTED', message: 'sealed' } }).error.code).toBe(
      'PDF_ENCRYPTED',
    );
    expect(
      ApiErrorSchema.parse({ error: { code: 'INTERNAL', message: 'x', detail: 'y' } }).error.detail,
    ).toBe('y');
  });

  it('rejects unknown codes and missing messages', () => {
    expect(ApiErrorSchema.safeParse({ error: { code: 'NOPE', message: 'x' } }).success).toBe(false);
    expect(ApiErrorSchema.safeParse({ error: { code: 'INTERNAL' } }).success).toBe(false);
  });
});

describe('document schemas', () => {
  it('parses a rect, page info, summary and detail', () => {
    expect(NormalizedRectSchema.parse({ x: 0, y: 0, w: 1, h: 1 })).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(PageInfoSchema.parse(page).extraction).toBe('text');
    expect(DocumentSummarySchema.parse(summary).id).toBe(DOC_ID);
    expect(DocumentDetailSchema.parse(detail).pages).toHaveLength(2);
    expect(
      DocumentDetailSchema.parse({
        ...detail,
        status: 'failed',
        stage: 'failed',
        error: { code: 'PDF_EMPTY', message: 'blank' },
      }).error?.code,
    ).toBe('PDF_EMPTY');
  });

  it('rejects rects outside the page, bad stages and non-ISO dates', () => {
    expect(NormalizedRectSchema.safeParse({ x: 1.2, y: 0, w: 1, h: 1 }).success).toBe(false);
    expect(DocumentSummarySchema.safeParse({ ...summary, stage: 'dreaming' }).success).toBe(false);
    expect(DocumentSummarySchema.safeParse({ ...summary, createdAt: 'yesterday' }).success).toBe(false);
  });

  it('parses the session document response with and without a document', () => {
    expect(SessionDocumentResponseSchema.parse({ document: null }).document).toBeNull();
    expect(SessionDocumentResponseSchema.parse({ document: detail }).document?.id).toBe(DOC_ID);
    expect(SessionDocumentResponseSchema.safeParse({}).success).toBe(false);
  });

  it('parses the 202 answer of POST /documents: the new document, a summary', () => {
    const answer = CreateDocumentResponseSchema.parse({
      document: { ...summary, status: 'processing', stage: 'queued' },
    });
    expect(answer.document.status).toBe('processing');
    expect(CreateDocumentResponseSchema.safeParse({}).success).toBe(false);
    expect(CreateDocumentResponseSchema.safeParse({ document: { id: 'x' } }).success).toBe(false);
  });
});

describe('progress and ingest events', () => {
  it('parses progress with optional direction, detail and queue position', () => {
    expect(
      ProgressEventSchema.parse({ stage: 'parsing', completed: 3, total: 40, unit: 'pages' }).completed,
    ).toBe(3);
    expect(
      ProgressEventSchema.parse({
        stage: 'analyzing',
        completed: 1,
        total: 1,
        unit: 'steps',
        direction: 'rtl',
        detail: 'ar',
      }).direction,
    ).toBe('rtl');
    expect(
      ProgressEventSchema.parse({ stage: 'queued', completed: 0, total: 2, unit: 'queue', queuePosition: 2 })
        .queuePosition,
    ).toBe(2);
  });

  it('parses every status of a tick answer', () => {
    const progress = { stage: 'embedding', completed: 4, total: 12, unit: 'chunks' };
    expect(IngestTickResponseSchema.parse({ status: 'running', progress }).status).toBe('running');
    expect(
      IngestTickResponseSchema.parse({ status: 'running', progress, retryAfterMs: 2000 }).retryAfterMs,
    ).toBe(2000);
    expect(
      IngestTickResponseSchema.parse({
        status: 'parked',
        progress: { ...progress, detail: 'daily quota reached' },
        retryAfterMs: 3_600_000,
      }).status,
    ).toBe('parked');
    expect(
      IngestTickResponseSchema.parse({
        status: 'ready',
        progress: { stage: 'ready', completed: 1, total: 1, unit: 'steps' },
        document: detail,
      }).document?.id,
    ).toBe(DOC_ID);
    expect(
      IngestTickResponseSchema.parse({
        status: 'failed',
        progress: { stage: 'failed', completed: 0, total: 0, unit: 'steps' },
        error: { code: 'INGEST_INTERRUPTED', message: 'interrupted' },
      }).error?.code,
    ).toBe('INGEST_INTERRUPTED');
  });

  it('rejects a tick answer with an unknown status or no progress', () => {
    const progress = { stage: 'ocr', completed: 0, total: 3, unit: 'pages' };
    expect(IngestTickResponseSchema.safeParse({ status: 'nope', progress }).success).toBe(false);
    expect(IngestTickResponseSchema.safeParse({ status: 'running' }).success).toBe(false);
    expect(
      IngestTickResponseSchema.safeParse({ status: 'running', progress, retryAfterMs: -1 }).success,
    ).toBe(false);
  });
});

describe('uploads', () => {
  it('parses both kinds of ticket and nothing else', () => {
    expect(UploadTicketSchema.parse({ mode: 'direct', maxBytes: 1024 }).mode).toBe('direct');
    const blob = {
      mode: 'blob',
      maxBytes: 1024,
      pathname: `${DOC_ID}.pdf`,
      clientPayload: 'signed',
      handleUploadUrl: '/api/uploads/blob',
    };
    expect(UploadTicketSchema.parse(blob).mode).toBe('blob');
    expect(UploadTicketSchema.safeParse({ mode: 'blob', maxBytes: 1024 }).success).toBe(false);
    expect(UploadTicketSchema.safeParse({ mode: 'ftp', maxBytes: 1024 }).success).toBe(false);
  });

  it('accepts only the canonical pathname of a ticket as a blob to make a document from, and needs the ticket', () => {
    const ticket = 'eyJzdWIiOiJ4In0.signature';
    expect(CreateDocumentFromBlobSchema.parse({ blobPathname: `${DOC_ID}.pdf`, ticket }).blobPathname).toBe(
      `${DOC_ID}.pdf`,
    );
    expect(
      CreateDocumentFromBlobSchema.parse({ blobPathname: `${DOC_ID}.pdf`, filename: 'سجل.pdf', ticket })
        .filename,
    ).toBe('سجل.pdf');
    const notUuids = [
      '../x.pdf',
      `${DOC_ID}.txt`,
      'folder/' + DOC_ID + '.pdf',
      '',
      DOC_ID,
      `${'-'.repeat(36)}.pdf`, // 36 characters of the right alphabet that are no uuid (it used to reach the database as one)
      `${'0'.repeat(36)}.pdf`,
      `${DOC_ID.toUpperCase()}.pdf`, // keys are lower case
    ];
    for (const bad of notUuids) {
      expect(CreateDocumentFromBlobSchema.safeParse({ blobPathname: bad, ticket }).success, bad).toBe(false);
    }
    // A create without its ticket is refused: the ticket is what makes the upload usable once.
    expect(CreateDocumentFromBlobSchema.safeParse({ blobPathname: `${DOC_ID}.pdf` }).success).toBe(false);
    expect(
      CreateDocumentFromBlobSchema.safeParse({ blobPathname: `${DOC_ID}.pdf`, ticket: '' }).success,
    ).toBe(false);
  });
});

describe('PublicConfigSchema and HealthSchema', () => {
  it('parses the public config', () => {
    const config = PublicConfigSchema.parse({
      maxUploadBytes: 52428800,
      maxPages: 300,
      acceptedMimeTypes: ['application/pdf'],
      llm: { provider: 'anthropic', model: 'claude-sonnet-5-5', available: true, profile: 'standard' },
      embeddings: { provider: 'gemini', model: 'gemini-embedding-2' },
      ocr: { provider: 'tesseract', available: false },
    });
    expect(config.llm.profile).toBe('standard');
    expect(config.llm.freeTierNotice).toBeUndefined();
  });

  it('says whether the search model can be called, and stays valid for a server that does not say', () => {
    const base = {
      maxUploadBytes: 1,
      maxPages: 1,
      acceptedMimeTypes: [],
      llm: { provider: 'gemini', model: 'm', available: true, profile: 'standard' },
      ocr: { provider: 'none', available: false },
    };
    expect(
      PublicConfigSchema.parse({ ...base, embeddings: { provider: 'gemini', model: 'e', available: false } })
        .embeddings.available,
    ).toBe(false);
    expect(
      PublicConfigSchema.parse({ ...base, embeddings: { provider: 'gemini', model: 'e' } }).embeddings
        .available,
    ).toBeUndefined();
    expect(
      PublicConfigSchema.safeParse({
        ...base,
        embeddings: { provider: 'gemini', model: 'e', available: 'yes' },
      }).success,
    ).toBe(false);
  });

  it('carries the free-tier notice when the server sets it', () => {
    const config = PublicConfigSchema.parse({
      maxUploadBytes: 1,
      maxPages: 1,
      acceptedMimeTypes: [],
      llm: { provider: 'gemini', model: 'm', available: true, profile: 'standard', freeTierNotice: true },
      embeddings: { provider: 'gemini', model: 'm' },
      ocr: { provider: 'none', available: false },
    });
    expect(config.llm.freeTierNotice).toBe(true);
  });

  it('rejects an unknown LLM profile', () => {
    expect(
      PublicConfigSchema.safeParse({
        maxUploadBytes: 1,
        maxPages: 1,
        acceptedMimeTypes: [],
        llm: { provider: 'local', model: 'm', available: true, profile: 'huge' },
        embeddings: { provider: 'local', model: 'm' },
        ocr: { provider: 'none', available: false },
      }).success,
    ).toBe(false);
  });

  it('parses health', () => {
    expect(
      HealthSchema.parse({
        ok: true,
        db: 'pglite',
        providers: { llm: 'anthropic', embeddings: 'local', ocr: 'tesseract' },
      }).db,
    ).toBe('pglite');
    expect(HealthSchema.safeParse({ ok: true, db: 'mysql', providers: {} }).success).toBe(false);
  });
});

describe('AskRequestSchema', () => {
  it('trims the question', () => {
    expect(AskRequestSchema.parse({ question: '  What is on page 2?  ' }).question).toBe(
      'What is on page 2?',
    );
  });

  it('rejects empty and whitespace-only questions', () => {
    expect(AskRequestSchema.safeParse({ question: '' }).success).toBe(false);
    expect(AskRequestSchema.safeParse({ question: '   \n\t ' }).success).toBe(false);
    expect(AskRequestSchema.safeParse({}).success).toBe(false);
  });

  it('accepts exactly 2000 characters and rejects 2001', () => {
    expect(QUESTION_MAX_CHARS).toBe(2000);
    expect(AskRequestSchema.safeParse({ question: 'a'.repeat(2000) }).success).toBe(true);
    expect(AskRequestSchema.safeParse({ question: 'a'.repeat(2001) }).success).toBe(false);
    // Trimming happens before the length check.
    expect(AskRequestSchema.safeParse({ question: `  ${'a'.repeat(2000)}  ` }).success).toBe(true);
  });

  it('accepts at most four visible pages', () => {
    expect(
      AskRequestSchema.parse({ question: 'q', context: { visiblePages: [1, 2, 3, 4] } }).context
        ?.visiblePages,
    ).toEqual([1, 2, 3, 4]);
    expect(
      AskRequestSchema.safeParse({ question: 'q', context: { visiblePages: [1, 2, 3, 4, 5] } }).success,
    ).toBe(false);
    expect(AskRequestSchema.safeParse({ question: 'q', context: { visiblePages: [0] } }).success).toBe(false);
  });
});

describe('RevealRequestSchema', () => {
  it('accepts both foci and nothing else', () => {
    expect(RevealRequestSchema.parse({ focus: 'answer' }).focus).toBe('answer');
    expect(RevealRequestSchema.parse({ focus: 'manuscript' }).focus).toBe('manuscript');
    expect(RevealRequestSchema.safeParse({ focus: 'everything' }).success).toBe(false);
  });
});

describe('CitationSchema', () => {
  it('parses a citation and allows a null section title', () => {
    expect(CitationSchema.parse(citation).marker).toBe('S1');
    expect(CitationSchema.parse({ ...citation, sectionTitle: null }).sectionTitle).toBeNull();
  });

  it('rejects a snippet over 400 characters and an empty marker', () => {
    expect(CitationSchema.safeParse({ ...citation, snippet: 'x'.repeat(401) }).success).toBe(false);
    expect(CitationSchema.safeParse({ ...citation, snippet: 'x'.repeat(400) }).success).toBe(true);
    expect(CitationSchema.safeParse({ ...citation, marker: '' }).success).toBe(false);
  });
});

describe('AnswerStreamEventSchema', () => {
  const events: Record<string, unknown> = {
    status: { type: 'status', stage: 'retrieving', elapsedMs: 120 },
    retrieval: {
      type: 'retrieval',
      query: 'Who founded the archive?',
      rewrittenQuery: null,
      searchedChunks: 24,
      retrievedChunks: 6,
      pages: [2, 3],
      evidence: 'strong',
      timingsMs: { embed: 12, semantic: 6, lexical: 3, total: 24 },
    },
    outline: {
      type: 'outline',
      sections: [{ title: 'The Founding', page: 2 }],
      pageCount: 5,
      languages: [{ code: 'en', share: 1 }],
    },
    token: { type: 'token', text: 'Alaric ' },
    citations: { type: 'citations', citations: [citation], consulted: [{ page: 2 }, { page: 3 }] },
    done: {
      type: 'done',
      messageId: DOC_ID,
      answer: 'Alaric Thornquist [S1].',
      mode: 'answer',
      grounded: true,
      timingsMs: { retrieval: 24, firstToken: 810, total: 2100 },
    },
    error: { type: 'error', error: { code: 'LLM_FAILED', message: 'The diary lost its train of thought.' } },
  };

  it.each(Object.entries(events))('parses the %s event', (type, event) => {
    expect(AnswerStreamEventSchema.parse(event).type).toBe(type);
  });

  it('parses done with no first token and the other modes', () => {
    const done = events.done as Record<string, unknown>;
    expect(
      AnswerStreamEventSchema.safeParse({
        ...done,
        mode: 'not_found',
        grounded: false,
        timingsMs: { retrieval: 10, firstToken: null, total: 11 },
      }).success,
    ).toBe(true);
    expect(AnswerStreamEventSchema.safeParse({ ...done, mode: 'passages' }).success).toBe(true);
    expect(AnswerStreamEventSchema.safeParse({ ...done, mode: 'guess' }).success).toBe(false);
  });

  it('says which guard refused, whether the reply was cut off, and why a call failed', () => {
    const done = events.done as Record<string, unknown>;
    const notFound = { ...done, mode: 'not_found', grounded: false };
    for (const refusedBy of ['evidence', 'grounding', 'model', null]) {
      expect(AnswerStreamEventSchema.parse({ ...notFound, refusedBy })).toMatchObject({ refusedBy });
    }
    expect(AnswerStreamEventSchema.safeParse({ ...notFound, refusedBy: 'someone' }).success).toBe(false);
    expect(AnswerStreamEventSchema.parse(done)).not.toHaveProperty('refusedBy'); // an older server says nothing
    expect(AnswerStreamEventSchema.parse({ ...done, truncated: true })).toMatchObject({ truncated: true });
    expect(AnswerStreamEventSchema.safeParse({ ...done, truncated: 'yes' }).success).toBe(false);
    const failure = events.error as { error: Record<string, unknown> };
    expect(
      AnswerStreamEventSchema.parse({
        type: 'error',
        error: { ...failure.error, code: 'RATE_LIMITED', detail: 'daily quota reached' },
      }),
    ).toMatchObject({ error: { detail: 'daily quota reached' } });
    expect(AnswerStreamEventSchema.parse(failure)).not.toHaveProperty('error.detail');
    expect(
      AnswerStreamEventSchema.safeParse({ type: 'error', error: { ...failure.error, detail: 42 } }).success,
    ).toBe(false);
  });

  it('parses every status stage and every evidence level', () => {
    for (const stage of ['rewriting', 'retrieving', 'generating']) {
      expect(AnswerStreamEventSchema.safeParse({ type: 'status', stage, elapsedMs: 0 }).success).toBe(true);
    }
    for (const evidence of ['strong', 'weak', 'none']) {
      expect(
        AnswerStreamEventSchema.safeParse({ ...(events.retrieval as Record<string, unknown>), evidence })
          .success,
      ).toBe(true);
    }
    expect(
      AnswerStreamEventSchema.safeParse({ type: 'status', stage: 'pondering', elapsedMs: 0 }).success,
    ).toBe(false);
  });

  it('rejects unknown event types and malformed events', () => {
    expect(AnswerStreamEventSchema.safeParse({ type: 'heartbeat' }).success).toBe(false);
    expect(AnswerStreamEventSchema.safeParse({ type: 'token' }).success).toBe(false);
  });
});

describe('MessageSchema and ConversationSchema', () => {
  const question = {
    id: DOC_ID,
    role: 'user' as const,
    kind: 'question' as const,
    content: 'Who founded it?',
    citations: [],
    createdAt: NOW,
  };
  const answer = {
    id: CHUNK_ID,
    role: 'assistant' as const,
    kind: 'answer' as const,
    content: 'Alaric Thornquist [S1].',
    mode: 'answer' as const,
    grounded: true,
    citations: [citation],
    createdAt: NOW,
  };

  it('parses questions, answers and reveals', () => {
    expect(MessageSchema.parse(question).kind).toBe('question');
    expect(MessageSchema.parse(answer).citations).toHaveLength(1);
    expect(MessageSchema.parse({ ...answer, kind: 'reveal' }).kind).toBe('reveal');
  });

  it('carries which guard refused an answer and whether it was cut off', () => {
    const refused = { ...answer, mode: 'not_found' as const, grounded: false };
    for (const refusedBy of ['evidence', 'grounding', 'model', null]) {
      expect(MessageSchema.parse({ ...refused, refusedBy })).toMatchObject({ refusedBy });
    }
    expect(MessageSchema.safeParse({ ...refused, refusedBy: 'someone' }).success).toBe(false);
    expect(MessageSchema.parse(answer)).not.toHaveProperty('refusedBy');
    expect(MessageSchema.parse({ ...answer, truncated: true }).truncated).toBe(true);
    expect(MessageSchema.safeParse({ ...answer, truncated: 'yes' }).success).toBe(false);
  });

  it('parses a conversation', () => {
    expect(
      ConversationSchema.parse({ documentId: DOC_ID, messages: [question, answer] }).messages,
    ).toHaveLength(2);
  });

  it('rejects an unknown role or kind', () => {
    expect(MessageSchema.safeParse({ ...question, role: 'system' }).success).toBe(false);
    expect(MessageSchema.safeParse({ ...question, kind: 'poem' }).success).toBe(false);
  });
});
