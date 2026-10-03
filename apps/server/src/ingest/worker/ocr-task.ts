import type { PDFDocument } from 'pdf-lib';
import {
  KEY_REJECTED_DETAIL,
  MODEL_NOT_FOUND_DETAIL,
  NO_QUOTA_DETAIL,
  isDailyQuotaError,
} from '../../gemini/index.js';
import { AppError } from '../../http/errors.js';
import { candidateLanguages } from '../../ocr/languages.js';
import { chooseLanguages } from '../../ocr/language-trial.js';
import { buildOcrPageText, type OcrPageGeometry } from '../../ocr/ocr-page.js';
import {
  isEncrypted,
  loadSourceDocument,
  pagesPdf,
  pdfOfRenderings,
  withoutPdfLibWarnings,
  type RenderedPage,
} from '../../ocr/page-pdf.js';
import {
  OCR_CAPABILITY_DETAIL,
  OcrUnavailableError,
  isBatchProvider,
  type OCRProvider,
  type OcrBatchProvider,
  type OcrImage,
  type OcrResult,
} from '../../ocr/types.js';
import { closePdf, loadPdf, type PDFDocumentProxy } from '../../pdf/load.js';
import { rasterizePage } from '../../pdf/rasterize.js';
import type { OcrSettings, OcrTask, WorkerMessage } from './protocol.js';

/*
 * The OCR task of an ingestion worker thread: read each page that needs it with the provider and build its text. Runs
 * inside the thread (the host watches it from outside: page timeout, memory, DELETE), so that a hostile page, the
 * WebAssembly engine, the rendered bitmaps and the model requests all live and die with the thread.
 *
 * Two ways of reading, by what the provider is:
 *  - a provider that reads documents (Gemini) is given several pages at once, cut out of the PDF as a small PDF of their
 *    own: requests are its scarce quota, pages are cheap (readBatches);
 *  - a provider that reads images (Tesseract) is given one rendered page at a time, after a language trial on the first
 *    pages (readPages).
 */

/** The language trial may take this many pages when the first ones hold too little text to tell languages apart. */
export const MAX_TRIAL_PAGES = 2;
/** Extra reads on the trial page besides the candidates: the other packs of the Arabic script (2), the combination, the extra language. */
const EXTRA_TRIAL_READS = 4;

/**
 * How many page timeouts rendering a page may take: two, because pdf.js decodes a scan in JavaScript (about 2 s for a
 * 200 DPI A4 JPEG, 8 s for a 4320 x 4320 one, and a 62 megapixel image takes minutes), which is a bigger job than the
 * text extraction a page timeout is sized for. Reading gets one page timeout per read: the trial page is read once per
 * candidate language, plus a combination and an extra language.
 */
export const RENDER_TIMEOUT_FACTOR = 2;

/**
 * How long a request to the model (cutting the pages out, sending them, waiting for the answer, the retries the OCR
 * provider makes: five attempts of at most a minute, at most two minutes of waiting between them, and the wait for a free
 * slot of the rate limit) may take before the host stops the thread. The budget of the whole document (OCR_MAX_SECONDS)
 * is still what bounds the run.
 */
export const BATCH_TIMEOUT_MS = 600_000;
/**
 * The most a request carries. The API takes 20 MB of request; base64 adds a third to the file, so 14 MB of PDF is 18.7 MB
 * of request. A batch that is bigger is split; a page that alone is bigger is sent as a rendering (a JPEG in a PDF of its
 * own).
 */
export const MAX_REQUEST_BYTES = 14 * 1024 * 1024;

export interface OcrTaskDeps {
  /** `probe` is the language the engine is started with when it is checked, before the first page is read. */
  createProvider(settings: OcrSettings, probe: string): OCRProvider;
  /** The most one request carries, in bytes (tests make it small). Default {@link MAX_REQUEST_BYTES}. */
  maxRequestBytes?: number;
}

const rawText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A sentence about why a page was not read, safe to show; the details stay in the worker's log. */
function curated(error: unknown): string {
  if (error instanceof OcrUnavailableError || error instanceof NoUsableText) return error.message;
  return 'the page could not be read by OCR';
}

/** The model answered, but not with text for this page (the answer was cut short or malformed, twice). */
class NoUsableText extends Error {
  constructor() {
    super('the model returned no usable text for the page');
    this.name = 'NoUsableText';
  }
}

export async function runOcrTask(
  task: OcrTask,
  post: (message: WorkerMessage) => void,
  deps: OcrTaskDeps,
): Promise<void> {
  const { settings } = task;
  const allowed = [...new Set([...settings.languages, ...settings.extraLanguages])];
  const candidates = candidateLanguages(task.languageSample, { configured: settings.languages, allowed });
  const provider = deps.createProvider(settings, task.languages?.[0] ?? candidates[0] ?? 'eng');
  try {
    const available = await provider.isAvailable();
    post({ type: 'ocr-ready', available });
    if (available && task.pages.length > 0 && task.bytes !== undefined) {
      if (isBatchProvider(provider)) {
        await readBatches(task, task.bytes, provider, post, deps.maxRequestBytes ?? MAX_REQUEST_BYTES);
      } else await readPages(task, task.bytes, candidates, provider, post);
    }
  } finally {
    await provider.dispose().catch(() => undefined);
  }
  post({ type: 'ocr-done' });
}

// --- readers of documents (Gemini): several pages per request ---------------------------------------------------------

interface Size {
  width: number;
  height: number;
}

/** What goes into one request: a PDF of `pages` (in this order). */
interface Prepared {
  pages: number[];
  data: Uint8Array;
  sizes: Size[];
}

/**
 * What became of the front of the queue: `used` pages left it, `prepared` is the PDF of those that can be sent (null when
 * none can), `lost` the ones that could not be made ready (a page that would not render, one too big to send).
 */
interface Preparation {
  used: number;
  prepared: Prepared | null;
  lost: { page: number; error: unknown }[];
}

const geometryOf = (size: Size): OcrPageGeometry => ({
  pageWidth: size.width,
  pageHeight: size.height,
  imageWidth: size.width,
  imageHeight: size.height,
});

/**
 * The first pages of `pages` cut out of the document as one PDF that fits in a request: as many as were asked for, fewer
 * when they are too big together (halved until they fit). Null when not even the first page can be had that way (a page
 * pdf-lib cannot copy, or a scan bigger than a request).
 */
async function copyPages(
  source: PDFDocument,
  pages: readonly number[],
  maxBytes: number,
): Promise<Prepared | null> {
  let take = [...pages];
  while (take.length > 0) {
    try {
      const built = await pagesPdf(source, take);
      if (built.pdf.byteLength <= maxBytes) return { pages: take, data: built.pdf, sizes: built.sizes };
    } catch {
      // a page that cannot be copied spoils the whole copy: the pieces are tried, down to the page alone
    }
    if (take.length === 1) return null;
    take = take.slice(0, Math.ceil(take.length / 2));
  }
  return null;
}

/**
 * The configuration the service refuses, when `error` says so: a rejected key, a model it does not know (401, 403, 404) or a
 * model that has no quota at all on this plan (a limit of 0). Waiting does not mend it, and no page is at fault.
 */
function configFaultOf(error: unknown): string | null {
  if (!(error instanceof AppError) || error.code !== 'LLM_UNAVAILABLE') return null;
  return error.detail === KEY_REJECTED_DETAIL ||
    error.detail === MODEL_NOT_FOUND_DETAIL ||
    error.detail === NO_QUOTA_DETAIL
    ? error.detail
    : null;
}

/** A failure of the model service: busy or down. Not the page's fault, and not a reason to call it damaged. */
const isServiceFailure = (error: unknown): boolean =>
  error instanceof AppError &&
  (error.code === 'RATE_LIMITED' || error.code === 'LLM_UNAVAILABLE') &&
  configFaultOf(error) === null;

/**
 * What ends the document's OCR at once, whatever the pages are: the daily quota, a configuration the service refuses
 * (the key, the model), or a service that refuses {@link MAX_REFUSALS} requests in a row (it does not take PDFs, or the
 * schema of the answer).
 */
type Stop = { kind: 'quota' } | { kind: 'config'; detail: string };

/** Requests refused in a row (a 400) after which the model is taken not to accept what is sent: one bad page cannot do that. */
export const MAX_REFUSALS = 3;

/** The model declined to read the pages, or refused the request: one page of a batch may be the cause. */
const isRefusal = (error: unknown): boolean =>
  error instanceof AppError && (error.code === 'OUTPUT_BLOCKED' || error.code === 'LLM_FAILED');

const SERVICE_MESSAGE = 'the model service was not available';

async function readBatches(
  task: OcrTask,
  bytes: Uint8Array,
  provider: OcrBatchProvider,
  post: (message: WorkerMessage) => void,
  maxBytes: number,
): Promise<void> {
  await withoutPdfLibWarnings(() => readBatchesQuietly(task, bytes, provider, post, maxBytes));
}

async function readBatchesQuietly(
  task: OcrTask,
  bytes: Uint8Array,
  provider: OcrBatchProvider,
  post: (message: WorkerMessage) => void,
  maxBytes: number,
): Promise<void> {
  const { settings } = task;
  const perRequest = Math.max(1, provider.pagesPerRequest);
  // null when pdf-lib cannot parse the file (pdf.js could): every page is then read from a rendering
  const source: PDFDocument | null = await loadSourceDocument(bytes).catch(() => null);
  // A document that is encrypted (even with only an owner password: pdf.js opens it, and so does everything that renders)
  // cannot be cut into a PDF the model can read: pdf-lib would copy the pages with their streams still encrypted, into a
  // file with no key. Its pages are read from renderings, packed into the same kind of PDF.
  const cutting = source !== null && !isEncrypted(source) ? source : null;
  // pdf.js opens the document only if a page has to be rendered.
  const rendering: { doc: PDFDocumentProxy | null } = { doc: null };
  const renderer = async (): Promise<PDFDocumentProxy> => (rendering.doc ??= await loadPdf(bytes));

  /** A request (cutting the pages out, sending them, the retries) may take as long as the model service needs. */
  const startRequest = (pageNumber: number): void =>
    post({ type: 'ocr-page-start', pageNumber, timeoutFactor: 1, timeoutMs: BATCH_TIMEOUT_MS });
  const startRender = (pageNumber: number): void =>
    post({ type: 'ocr-page-start', pageNumber, timeoutFactor: RENDER_TIMEOUT_FACTOR });
  const reportPage = (pageNumber: number, error: unknown): void =>
    post({ type: 'ocr-page-error', pageNumber, message: curated(error), raw: rawText(error) });
  /** One request failed for these pages: counted once when it is the service's failure. */
  const reportRequest = (pageNumbers: number[], error: unknown): void => {
    if (isServiceFailure(error)) {
      post({
        type: 'ocr-request-failed',
        pageNumbers,
        service: true,
        message: SERVICE_MESSAGE,
        raw: rawText(error),
      });
    } else {
      for (const pageNumber of pageNumbers) reportPage(pageNumber, error);
    }
  };
  const postPage = (pageNumber: number, result: OcrResult, size: Size): void => {
    const text = buildOcrPageText(result, geometryOf(size));
    post({
      type: 'ocr-page',
      page: { pageNumber, confidence: text.confidence, languages: result.languagesUsed, text },
    });
  };

  /** The first pages of `pages` rendered (one at a time, each with the time rendering needs) and packed into one PDF. */
  const render = async (pages: readonly number[]): Promise<Preparation> => {
    const lost: Preparation['lost'] = [];
    const drawn: RenderedPage[] = [];
    const kept: number[] = [];
    let used = 0;
    let total = 0;
    for (const pageNumber of pages) {
      startRender(pageNumber);
      let page: RenderedPage;
      try {
        const raster = await rasterizePage(await renderer(), pageNumber, {
          dpi: settings.dpi,
          format: 'jpeg',
        });
        page = { jpeg: raster.png, width: raster.pageWidth, height: raster.pageHeight };
      } catch (error) {
        used += 1;
        lost.push({ page: pageNumber, error });
        continue;
      }
      if (total + page.jpeg.byteLength > maxBytes) {
        if (kept.length > 0) break; // for the next request
        used += 1;
        lost.push({
          page: pageNumber,
          error: new OcrUnavailableError('the page is too large to be sent for OCR'),
        });
        continue;
      }
      total += page.jpeg.byteLength;
      used += 1;
      kept.push(pageNumber);
      drawn.push(page);
    }
    if (kept.length === 0) return { used, prepared: null, lost };
    return {
      used,
      prepared: {
        pages: kept,
        data: await pdfOfRenderings(drawn),
        sizes: drawn.map(({ width, height }) => ({ width, height })),
      },
      lost,
    };
  };

  const prepare = async (pages: readonly number[]): Promise<Preparation> => {
    if (cutting === null) return render(pages);
    const copied = await copyPages(cutting, pages, maxBytes);
    if (copied !== null) return { used: copied.pages.length, prepared: copied, lost: [] };
    // Not even the first page can be had as a PDF that fits: that page alone is read from a rendering.
    return render(pages.slice(0, 1));
  };

  /** Requests the service refused in a row (a 400), counted to tell a bad page from a model that takes nothing we send. */
  let refusals = 0;

  /** One page alone. Null: the model gave no usable text. Throws when the request failed. */
  const readAlone = async (
    pageNumber: number,
    size: Size | null,
  ): Promise<{ result: OcrResult | null; size: Size }> => {
    startRequest(pageNumber);
    const { prepared, lost } = await prepare([pageNumber]);
    if (prepared === null) throw (lost[0]?.error as Error | undefined) ?? new NoUsableText();
    startRequest(pageNumber);
    const [result] = await provider.recognizeBatch(
      { data: prepared.data, mimeType: 'application/pdf', pageCount: 1 },
      { languages: [], pageNumber },
    );
    refusals = 0; // the service took the request
    return { result: result ?? null, size: prepared.sizes[0] ?? size ?? { width: 0, height: 0 } };
  };

  const stopOf = (error: unknown): Stop | null => {
    if (isDailyQuotaError(error)) return { kind: 'quota' };
    const fault = configFaultOf(error);
    if (fault !== null) return { kind: 'config', detail: fault };
    if (error instanceof AppError && error.code === 'LLM_FAILED') {
      refusals += 1;
      if (refusals >= MAX_REFUSALS) return { kind: 'config', detail: OCR_CAPABILITY_DETAIL };
    }
    return null;
  };

  /** Settles a page: the batch's answer for it, else the page alone, once. A page that stays unread is reported. */
  const settle = async (
    pageNumber: number,
    size: Size | null,
    answer: OcrResult | null,
  ): Promise<Stop | null> => {
    try {
      let result = answer;
      let measured = size;
      if (result === null) {
        const alone = await readAlone(pageNumber, size);
        result = alone.result;
        measured = alone.size;
      }
      if (result === null || measured === null) throw new NoUsableText();
      postPage(pageNumber, result, measured);
    } catch (error) {
      const stop = stopOf(error);
      if (stop !== null) return stop;
      reportRequest([pageNumber], error);
    }
    return null;
  };

  const queue = [...task.pages];
  let stop: Stop | null = null;
  try {
    while (queue.length > 0 && stop === null) {
      startRequest(queue[0] ?? 0);
      const { used, prepared: batch, lost } = await prepare(queue.slice(0, perRequest));
      queue.splice(0, used);
      for (const { page, error } of lost) reportPage(page, error);
      if (batch === null) continue;
      const first = batch.pages[0] ?? 0;
      startRequest(first);
      let answers: (OcrResult | null)[] | null = null;
      try {
        answers = await provider.recognizeBatch(
          { data: batch.data, mimeType: 'application/pdf', pageCount: batch.pages.length },
          { languages: [], pageNumber: first },
        );
        refusals = 0; // the service took the request
      } catch (error) {
        stop = stopOf(error);
        if (stop === null) {
          if (isRefusal(error) && batch.pages.length > 1) {
            // One page of the batch may be what the service objects to: each is tried alone.
            answers = null;
          } else {
            reportRequest(batch.pages, error);
            continue;
          }
        }
      }
      // The pages the answer has are done; the ones it lacks are asked for again, alone (unless the job is stopped).
      const missing: number[] = [];
      for (const [index, pageNumber] of batch.pages.entries()) {
        const answer = answers?.[index] ?? null;
        if (answer === null) missing.push(index);
        else await settle(pageNumber, batch.sizes[index] ?? null, answer);
      }
      for (const index of missing) {
        if (stop !== null) break;
        stop = await settle(batch.pages[index] ?? 0, batch.sizes[index] ?? null, null);
      }
    }
    // The pages not read are not settled here: the host fails them with the reason (quota, or the fault of the configuration).
    if (stop?.kind === 'quota') post({ type: 'ocr-quota' });
    if (stop?.kind === 'config') post({ type: 'ocr-config-fault', detail: stop.detail });
  } finally {
    if (rendering.doc !== null) await closePdf(rendering.doc).catch(() => undefined);
  }
}

// --- readers of images (Tesseract): one page at a time, after the language trial -------------------------------------

async function readPages(
  task: OcrTask,
  bytes: Uint8Array,
  candidates: readonly string[],
  provider: OCRProvider,
  post: (message: WorkerMessage) => void,
): Promise<void> {
  const { settings } = task;
  // The configured languages the document's own text did not name: tried only if the candidates read the page badly.
  const fallback = settings.languages.filter((language) => !candidates.includes(language));
  const doc = await loadPdf(bytes);
  try {
    let languages = task.languages;
    let trialPages = 0;
    for (const pageNumber of task.pages) {
      post({
        type: 'ocr-page-start',
        pageNumber,
        timeoutFactor: RENDER_TIMEOUT_FACTOR,
      });
      try {
        const raster = await rasterizePage(doc, pageNumber, { dpi: settings.dpi });
        const trial = provider.selectsLanguages && languages === null;
        post({
          type: 'ocr-reading',
          timeoutFactor: trial ? candidates.length + fallback.length + EXTRA_TRIAL_READS : 1,
        });
        const image: OcrImage = { png: raster.png, width: raster.width, height: raster.height };
        const read = (packs: string[]): Promise<OcrResult> =>
          provider.recognize(image, { languages: packs, pageNumber });
        let result: OcrResult;
        if (!provider.selectsLanguages) {
          result = await read([]);
        } else if (languages === null) {
          const choice = await chooseLanguages({
            candidates: [...candidates],
            fallback,
            extra: settings.extraLanguages,
            recognize: read,
          });
          result = choice.result;
          trialPages += 1;
          if (choice.decided || trialPages >= MAX_TRIAL_PAGES) {
            languages = choice.languages;
            post({ type: 'ocr-languages', languages });
          }
        } else {
          result = await read(languages);
        }
        const text = buildOcrPageText(result, {
          pageWidth: raster.pageWidth,
          pageHeight: raster.pageHeight,
          imageWidth: raster.width,
          imageHeight: raster.height,
        });
        post({
          type: 'ocr-page',
          page: { pageNumber, confidence: text.confidence, languages: result.languagesUsed, text },
        });
      } catch (error) {
        post({ type: 'ocr-page-error', pageNumber, message: curated(error), raw: rawText(error) });
      }
    }
  } finally {
    await closePdf(doc).catch(() => undefined);
  }
}
