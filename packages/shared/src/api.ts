import { ERROR_CODES, WARNING_CODES } from './errors.js';
import { QUESTION_MAX_CHARS } from './limits.js';
import { z } from './zod.js';

/*
 * The API contract. Every request and response body is described here once and parsed with zod on the
 * receiving side (server for requests, web for responses). Field names are part of the contract: later
 * tasks may only ADD optional fields.
 */

// ---------------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------------

/** Ids are server-generated UUIDs. `guid` accepts any 8-4-4-4-12 hex id, which keeps fixtures easy to write. */
const IdSchema = z.guid();
const IsoDateSchema = z.iso.datetime();
const PageNumberSchema = z.int().min(1);
const CountSchema = z.int().min(0);

export const ErrorCodeSchema = z.enum(ERROR_CODES);
export const WarningCodeSchema = z.enum(WARNING_CODES);

export const DirectionSchema = z.enum(['ltr', 'rtl']);
export type Direction = z.infer<typeof DirectionSchema>;

/** A rectangle on a page in fractions of the page size, origin top-left. */
export const NormalizedRectSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
});
export type NormalizedRect = z.infer<typeof NormalizedRectSchema>;

// ---------------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------------

/** `detail` is curated by the server: no file-system paths, SQL or stack traces. */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    detail: z.string().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorSchema>;

// ---------------------------------------------------------------------------------------------------
// Documents and ingestion
// ---------------------------------------------------------------------------------------------------

export const IngestStageSchema = z.enum([
  'queued',
  'validating',
  'parsing',
  'ocr',
  'analyzing',
  'chunking',
  'embedding',
  'storing',
  'ready',
  'failed',
]);
export type IngestStage = z.infer<typeof IngestStageSchema>;

export const PageInfoSchema = z.object({
  pageNumber: PageNumberSchema,
  width: z.number().positive(),
  height: z.number().positive(),
  language: z.string(),
  direction: DirectionSchema,
  extraction: z.enum(['text', 'ocr', 'empty']),
  charCount: CountSchema,
  ocrConfidence: z.number().nullable(),
});
export type PageInfo = z.infer<typeof PageInfoSchema>;

export const DocumentWarningSchema = z.object({
  code: WarningCodeSchema,
  pages: z.array(PageNumberSchema),
});
export type DocumentWarning = z.infer<typeof DocumentWarningSchema>;

export const DocumentSummarySchema = z.object({
  id: IdSchema,
  filename: z.string(),
  byteSize: CountSchema,
  pageCount: CountSchema,
  status: z.enum(['processing', 'ready', 'failed']),
  stage: IngestStageSchema,
  primaryLanguage: z.string(),
  direction: DirectionSchema,
  createdAt: IsoDateSchema,
  expiresAt: IsoDateSchema,
});
export type DocumentSummary = z.infer<typeof DocumentSummarySchema>;

export const DocumentDetailSchema = DocumentSummarySchema.extend({
  languages: z.array(z.object({ code: z.string(), share: z.number().min(0).max(1) })),
  pages: z.array(PageInfoSchema),
  warnings: z.array(DocumentWarningSchema),
  sections: z.array(z.object({ title: z.string(), page: PageNumberSchema })),
  chunkCount: CountSchema,
  error: z.object({ code: ErrorCodeSchema, message: z.string() }).optional(),
});
export type DocumentDetail = z.infer<typeof DocumentDetailSchema>;

/** Real progress only: `completed` / `total` are counts of `unit`, never an estimated percentage. */
export const ProgressEventSchema = z.object({
  stage: IngestStageSchema,
  completed: CountSchema,
  total: CountSchema,
  unit: z.enum(['pages', 'chunks', 'bytes', 'steps', 'queue']),
  detail: z.string().optional(),
  /** Emitted by the `analyzing` stage as soon as the document direction is known. */
  direction: DirectionSchema.optional(),
  queuePosition: CountSchema.optional(),
});
export type ProgressEvent = z.infer<typeof ProgressEventSchema>;

/**
 * Where an ingestion stands. Documents are read in short steps ("ticks"): the client asks `POST /documents/:id/tick` over
 * and over until the status is `ready` or `failed`, and shows `progress`, which is real (counts of pages or chunks, never an
 * estimate). `parked`: a daily quota of the model service is used up and the document waits for it to start again
 * (`retryAfterMs` says how long; `progress.detail` says why); a tick on a parked document does nothing. `retryAfterMs` on a
 * `running` answer asks the client to wait that long before the next tick (the line of documents is full, or a rate limit).
 */
export const IngestStatusSchema = z.enum(['running', 'ready', 'failed', 'parked']);
export type IngestStatus = z.infer<typeof IngestStatusSchema>;

export const IngestTickResponseSchema = z.object({
  status: IngestStatusSchema,
  progress: ProgressEventSchema,
  /** The finished document, with `ready`. */
  document: DocumentDetailSchema.optional(),
  /** Why it failed, with `failed`. */
  error: z.object({ code: ErrorCodeSchema, message: z.string() }).optional(),
  retryAfterMs: CountSchema.optional(),
});
export type IngestTickResponse = z.infer<typeof IngestTickResponseSchema>;

// ---------------------------------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------------------------------

/**
 * How this server wants a file uploaded (`POST /api/uploads/ticket`). `direct`: as multipart/form-data in `POST /api/documents`
 * (development and self-hosting). `blob`: straight from the browser to a private Vercel Blob store, which gets around the
 * 4.5 MB body limit of a serverless function: the client calls `upload(pathname, file, { access: 'private', handleUploadUrl,
 * clientPayload, multipart: false })` of `@vercel/blob/client` (a single put: `maxBytes` is 20 MB by default, and a multipart
 * upload costs several operations of a small quota), then `POST /api/documents` with `{ blobPathname, filename, ticket }`,
 * where `ticket` is `clientPayload` sent back. A ticket is good for ONE document (see `CreateDocumentFromBlobSchema`).
 */
export const UploadTicketSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('direct'), maxBytes: z.int().positive() }),
  z.object({
    mode: z.literal('blob'),
    maxBytes: z.int().positive(),
    /** The name the server chose for the blob (`<uuid>.pdf`): the upload must use exactly this. */
    pathname: z.string().min(1),
    /** Signed by the server; goes along as `clientPayload` of `upload()`. */
    clientPayload: z.string().min(1),
    /** Where `upload()` asks for its token (`handleUploadUrl`). */
    handleUploadUrl: z.string().min(1),
  }),
]);
export type UploadTicket = z.infer<typeof UploadTicketSchema>;

/** `POST /api/documents` with a JSON body: the document is the blob the browser just uploaded under a ticket. */
export const CreateDocumentFromBlobSchema = z.object({
  blobPathname: z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/u,
      'must be the pathname of the ticket',
    ),
  /** The file name to show (the blob's own name is a uuid). */
  filename: z.string().min(1).max(255).optional(),
  /**
   * The ticket the server issued for this upload (`UploadTicket.clientPayload`), sent back unchanged. It names the session and
   * the pathname, and is good for ONE document: a create without it, with another session's, or one that was used is refused.
   */
  ticket: z.string().min(1).max(2000),
});
export type CreateDocumentFromBlob = z.infer<typeof CreateDocumentFromBlobSchema>;

/** The answer (202) of `POST /api/documents`, multipart or from a blob: the new document, still `processing`. */
export const CreateDocumentResponseSchema = z.object({ document: DocumentSummarySchema });
export type CreateDocumentResponse = z.infer<typeof CreateDocumentResponseSchema>;

/** The newest `ready` or `processing` document of the session; never a `failed` one. */
export const SessionDocumentResponseSchema = z.object({
  document: DocumentDetailSchema.nullable(),
});
export type SessionDocumentResponse = z.infer<typeof SessionDocumentResponseSchema>;

// ---------------------------------------------------------------------------------------------------
// Public configuration and health
// ---------------------------------------------------------------------------------------------------

/** The answer profile. There is one (the "small" one was for local models, which are gone). */
export const LlmProfileSchema = z.enum(['standard']);
export type LlmProfile = z.infer<typeof LlmProfileSchema>;

export const PublicConfigSchema = z.object({
  maxUploadBytes: z.int().positive(),
  maxPages: z.int().positive(),
  acceptedMimeTypes: z.array(z.string()),
  llm: z.object({
    provider: z.string(),
    model: z.string(),
    available: z.boolean(),
    profile: LlmProfileSchema,
    /**
     * True when the questions, the document text and the answers go to a free-tier service whose terms let the provider
     * use them to improve its products (Gemini's free tier): the UI shows a disclosure. Absent means false.
     */
    freeTierNotice: z.boolean().optional(),
  }),
  embeddings: z.object({
    provider: z.string(),
    model: z.string(),
    /** The embedding provider can be used (its key is set): without it questions cannot be searched. Absent means unknown. */
    available: z.boolean().optional(),
  }),
  ocr: z.object({ provider: z.string(), available: z.boolean() }),
});
export type PublicConfig = z.infer<typeof PublicConfigSchema>;

export const HealthSchema = z.object({
  ok: z.boolean(),
  db: z.enum(['pg', 'pglite']),
  providers: z.object({ llm: z.string(), embeddings: z.string(), ocr: z.string() }),
});
export type Health = z.infer<typeof HealthSchema>;

// ---------------------------------------------------------------------------------------------------
// Questions, answers, citations
// ---------------------------------------------------------------------------------------------------

export const AskRequestSchema = z.object({
  question: z.string().trim().min(1).max(QUESTION_MAX_CHARS),
  /** What the reader currently sees; used to resolve "this page". At most four pages (two spreads). */
  context: z.object({ visiblePages: z.array(PageNumberSchema).max(4) }).optional(),
});
export type AskRequest = z.infer<typeof AskRequestSchema>;

export const RevealRequestSchema = z.object({
  focus: z.enum(['answer', 'manuscript']),
});
export type RevealRequest = z.infer<typeof RevealRequestSchema>;

export const CitationSchema = z.object({
  /** The marker the model used in its answer, e.g. "S1". */
  marker: z.string().min(1),
  chunkId: IdSchema,
  pageStart: PageNumberSchema,
  pageEnd: PageNumberSchema,
  sectionTitle: z.string().nullable(),
  /** A sanitised excerpt of the cited chunk. */
  snippet: z.string().max(400),
  language: z.string(),
  direction: DirectionSchema,
  highlights: z.array(z.object({ page: PageNumberSchema, rects: z.array(NormalizedRectSchema) })),
});
export type Citation = z.infer<typeof CitationSchema>;

export const AnswerModeSchema = z.enum(['answer', 'passages', 'not_found']);
export type AnswerMode = z.infer<typeof AnswerModeSchema>;

/**
 * Which of the three guards refused to answer (Lab 2's "guard" column), or null when the question was answered:
 * `evidence` = nothing relevant was retrieved (score floor / no lexical hit), `grounding` = the retrieved text is related
 * but a yes/no check says it does not contain the answer, `model` = the model itself replied NOT_IN_DOCUMENT.
 */
export const RefusedBySchema = z.enum(['evidence', 'grounding', 'model']);
export type RefusedBy = z.infer<typeof RefusedBySchema>;

export const EvidenceSchema = z.enum(['strong', 'weak', 'none']);
export type Evidence = z.infer<typeof EvidenceSchema>;

/** Heartbeats are SSE comment frames (`: hb`), not events, so they are not part of this union. */
export const AnswerStreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('status'),
    stage: z.enum(['rewriting', 'retrieving', 'generating']),
    elapsedMs: CountSchema,
  }),
  z.object({
    type: z.literal('retrieval'),
    query: z.string(),
    rewrittenQuery: z.string().nullable(),
    searchedChunks: CountSchema,
    retrievedChunks: CountSchema,
    pages: z.array(PageNumberSchema),
    evidence: EvidenceSchema,
    timingsMs: z.object({
      embed: z.number().min(0),
      semantic: z.number().min(0),
      lexical: z.number().min(0),
      total: z.number().min(0),
    }),
  }),
  /** Reveal only: an outline of the manuscript. */
  z.object({
    type: z.literal('outline'),
    sections: z.array(z.object({ title: z.string(), page: PageNumberSchema })),
    pageCount: CountSchema,
    languages: z.array(z.object({ code: z.string(), share: z.number().min(0).max(1) })),
  }),
  z.object({ type: z.literal('token'), text: z.string() }),
  z.object({
    type: z.literal('citations'),
    citations: z.array(CitationSchema),
    consulted: z.array(z.object({ page: PageNumberSchema })),
  }),
  z.object({
    type: z.literal('done'),
    messageId: IdSchema,
    /** The final cleaned text. It is authoritative: the client replaces the streamed tokens with it. */
    answer: z.string(),
    mode: AnswerModeSchema,
    grounded: z.boolean(),
    /** Set when `mode` is `not_found`: which guard refused (see RefusedBySchema). Older servers omit it. */
    refusedBy: RefusedBySchema.nullable().optional(),
    /** The reply was cut off (the output limit, or a filter that stopped it after some text). Absent means false. */
    truncated: z.boolean().optional(),
    timingsMs: z.object({
      retrieval: z.number().min(0),
      firstToken: z.number().min(0).nullable(),
      total: z.number().min(0),
    }),
  }),
  z.object({
    type: z.literal('error'),
    // `detail` is a short curated hint, such as "daily quota reached" for RATE_LIMITED (the UI words it in the diary's voice).
    error: z.object({ code: ErrorCodeSchema, message: z.string(), detail: z.string().optional() }),
  }),
]);
export type AnswerStreamEvent = z.infer<typeof AnswerStreamEventSchema>;

// ---------------------------------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------------------------------

export const MessageSchema = z.object({
  id: IdSchema,
  role: z.enum(['user', 'assistant']),
  kind: z.enum(['question', 'answer', 'reveal']),
  content: z.string(),
  mode: AnswerModeSchema.optional(),
  grounded: z.boolean().optional(),
  /** For a `not_found` answer: which guard refused (the dev panel shows it). */
  refusedBy: RefusedBySchema.nullable().optional(),
  /** The reply was cut off (the output limit, or a filter that stopped it after some text). Absent means false. */
  truncated: z.boolean().optional(),
  citations: z.array(CitationSchema),
  createdAt: IsoDateSchema,
});
export type Message = z.infer<typeof MessageSchema>;

export const ConversationSchema = z.object({
  documentId: IdSchema,
  messages: z.array(MessageSchema),
});
export type Conversation = z.infer<typeof ConversationSchema>;
