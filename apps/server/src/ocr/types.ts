/*
 * The OCR abstraction. A provider turns one page into text; the pipeline (preparing the page, choosing languages,
 * building blocks) does not know which engine is behind it. Engines differ in what they read and what they return:
 *  - Tesseract (optional, self-hosted) reads a PNG rendering of the page and returns line boxes and a confidence;
 *  - Gemini (the default) reads the page itself, as a one-page PDF, and returns the text in reading order (no boxes,
 *    no confidence).
 */

/** A rendered page. `width` and `height` are in pixels; box coordinates in a result are in the same pixels. */
export interface OcrImage {
  png: Buffer;
  width: number;
  height: number;
}

/** One page as a PDF of its own (`width` and `height` in points), for providers that read documents. */
export interface OcrPdfPage {
  pdf: Uint8Array;
  width: number;
  height: number;
}

/** What a provider is given: a rendering (`png`) or the page as a PDF (`pdf`), as its `input` says. */
export type OcrPage = OcrImage | OcrPdfPage;

export const isPdfPage = (page: OcrPage): page is OcrPdfPage => 'pdf' in page;

/**
 * Several pages in one request: a PDF of `pageCount` pages (or one PNG, `pageCount` 1). The pages are numbered 1 to
 * `pageCount` in the order they have in the file.
 */
export interface OcrBatch {
  data: Uint8Array;
  mimeType: 'application/pdf' | 'image/png';
  pageCount: number;
}

export interface OcrBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrLine {
  text: string;
  bbox: OcrBox;
  /** 0..100. */
  confidence: number;
}

export interface OcrResult {
  text: string;
  /** Mean confidence of the page, 0..100 (0 for a page without text); null when the engine reports none (Gemini). */
  confidence: number | null;
  /** Lines with boxes in the pixels of the image (`layout` 'boxes'); empty for a `layout` of 'page'. */
  lines: OcrLine[];
  /** The language packs the page was read with (Tesseract codes: `eng`, `ara`, ...); empty when there are none to choose. */
  languagesUsed: string[];
  /**
   * 'boxes' (the default): `lines` carry boxes and `text` is their text. 'page': the engine returned text only, line by
   * line with a blank line between paragraphs, and every highlight is the whole page.
   */
  layout?: 'boxes' | 'page';
}

export interface OcrRecognizeOptions {
  /** Language packs, Tesseract codes. Several mean "read with all of them". Ignored by providers that need none. */
  languages: string[];
  /** Aborting stops the work; the provider recovers on the next call. */
  signal?: AbortSignal;
  /** The page being read, for logs and diagnostics (a provider never needs it to read). */
  pageNumber?: number;
}

export interface OCRProvider {
  readonly name: string;
  /** What the provider reads: a PNG rendering of the page, or the page as a PDF of its own. */
  readonly input: 'png' | 'pdf';
  /** True when the provider reads one language pack at a time and the pipeline has to choose (Tesseract). */
  readonly selectsLanguages: boolean;
  /** How many pages one request may carry (1 when the provider reads a page at a time). */
  readonly pagesPerRequest: number;
  /** True when the engine can start (language data present or fetchable). Cached: never downloads on every call. */
  isAvailable(): Promise<boolean>;
  recognize(page: OcrPage, options: OcrRecognizeOptions): Promise<OcrResult>;
  /** Releases the engine (a worker, memory). The provider may be used again afterwards. */
  dispose(): Promise<void>;
}

/**
 * The `detail` of a page OCR could not read because the model service could not answer (busy, down, refused the key): the
 * page is OCR_PARTIAL, and a document with nothing else to read fails as "try again later", not as damaged.
 */
export const OCR_SERVICE_DETAIL = 'model service unavailable';

/** The `detail` of a page left because the time allowed for the document's OCR (OCR_MAX_SECONDS) ran out: the same upload may do better later. */
export const OCR_BUDGET_DETAIL = 'time allowed for OCR used up';

/**
 * The `detail` of the pages left when the model refused three requests in a row: it does not take what is sent (a PDF
 * as input, or a JSON schema for the answer), which is a fault of the configuration (OCR_MODEL), not of the pages.
 */
export const OCR_CAPABILITY_DETAIL = 'the model refuses every request (check OCR_MODEL)';

/** The engine cannot start (no language data and no way to get it, a broken install). */
export class OcrUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OcrUnavailableError';
  }
}

/**
 * A provider that can read several pages in one request (Gemini: requests are the scarce quota, pages are cheap). The
 * result has one entry per page of the batch, null for a page the engine returned nothing usable for; a request that
 * fails as a whole throws.
 */
export interface OcrBatchProvider extends OCRProvider {
  recognizeBatch(batch: OcrBatch, options: OcrRecognizeOptions): Promise<(OcrResult | null)[]>;
}

export const isBatchProvider = (provider: OCRProvider): provider is OcrBatchProvider =>
  'recognizeBatch' in provider;
