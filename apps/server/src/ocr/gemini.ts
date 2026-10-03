import {
  BlockedReason,
  FinishReason,
  HarmBlockThreshold,
  HarmCategory,
  ThinkingLevel,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from '@google/genai';
import { z } from 'zod';
import {
  GeminiEmptyResponseError,
  geminiText,
  isAbortLike,
  isDailyQuotaError,
  mapGeminiError,
  parseGeminiError,
  withGeminiRetry,
  type GeminiClient,
  type GeminiPacer,
  type RetryOptions,
} from '../gemini/index.js';
import { AppError } from '../http/errors.js';
import { OCR_SYSTEM_INSTRUCTION, ocrUserPrompt } from './prompts.js';
import {
  OcrUnavailableError,
  isPdfPage,
  type OcrBatch,
  type OcrBatchProvider,
  type OcrPage,
  type OcrRecognizeOptions,
  type OcrResult,
} from './types.js';

/*
 * The Gemini OCR provider (OCR_PROVIDER=gemini, the default). Requests are the scarce quota (a free key allows a few
 * hundred a day), pages are cheap: so several pages go in one request, as a small PDF cut out of the document, and the
 * model answers with strict JSON, `[{page, lines}]`, which is validated and mapped back to the pages. A page whose entry
 * is garbled is returned as null for the caller to ask for again, alone; an answer that leaves a page out, repeats one or
 * numbers them wrongly cannot be trusted at all (see `pagesOfAnswer`): every page of it is null, and the caller asks for
 * each of them alone. What comes back is text in reading order: no boxes and no confidence, so the pipeline records `ocr_confidence` as null, highlights the whole page, and
 * needs no language packs to choose.
 */

export interface GeminiOcrOptions {
  client: GeminiClient;
  /** OCR_MODEL, for example `gemini-3.5-flash-lite`. */
  model: string;
  /** OCR_PAGES_PER_REQUEST. */
  pagesPerRequest?: number;
  pacer?: GeminiPacer;
  /** Attempts, delays and limits of the retry (the pacer and the signal are the provider's). */
  retry?: Omit<RetryOptions, 'pacer' | 'signal'>;
  /** The most the model may write for one request. Eight dense pages are about 16,000 tokens; this is the room. */
  maxOutputTokens?: number;
  /** One attempt that takes longer is abandoned (and retried). Default {@link REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs?: number;
}

/** One attempt may take this long: a batch of dense pages is some 16,000 tokens of output, which takes a minute at most. */
export const REQUEST_TIMEOUT_MS = 60_000;
/**
 * Patience of one request: five attempts; a 429 that asks to wait is waited for up to a minute (a per-minute limit asks
 * for as much), a 5xx is retried after 2, 4, 8 and 16 s (with jitter), and no more than two minutes are spent waiting in
 * all. With the waits for a free slot of the rate limit, the worst case is about eight minutes, which the host's watchdog
 * for a request (`BATCH_TIMEOUT_MS`) and the budget of the document (`OCR_MAX_SECONDS`) both allow for.
 */
export const OCR_RETRY = {
  maxAttempts: 5,
  baseDelayMs: 2_000,
  maxDelayMs: 65_000,
  maxTotalWaitMs: 130_000,
} as const;

const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;

/** The shape the model is asked for (the schema of the request). */
const PageEntry = z.object({ page: z.number().int().min(1), lines: z.array(z.string()) });
const BatchAnswer = z.array(PageEntry);
const Numbered = z.object({ page: z.number().int() });
const Lines = z.array(z.string());

/** JSON Schema of the answer, for the API's structured-output mode (the `$schema` marker is not part of its subset). */
function answerSchema(): Record<string, unknown> {
  const { $schema: _marker, ...schema } = z.toJSONSchema(BatchAnswer) as Record<string, unknown>;
  return schema;
}

/**
 * Transcription is not a place for the model to be creative or to hold back: temperature 0, and the filters set to block
 * only what is certainly harmful (a page of a history book or a medical text must not be refused for what it quotes).
 */
const SAFETY_SETTINGS = [
  HarmCategory.HARM_CATEGORY_HARASSMENT,
  HarmCategory.HARM_CATEGORY_HATE_SPEECH,
  HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
  HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
].map((category) => ({ category, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH }));

/** The text of a page from the lines the model wrote: one per printed line, an empty one between paragraphs. */
export function textOfLines(lines: readonly string[]): string {
  return lines
    .map((line) => line.replace(/\r\n?|\n/gu, ' ').trimEnd())
    .join('\n')
    .replace(/^\n+|\n+$/gu, '');
}

/** The JSON of an answer, with a code fence around it (which the instructions forbid and models still sometimes add) removed. */
function parseAnswer(raw: string): unknown {
  const fenced = /^```[a-z]*\n([\s\S]*?)\n?```$/iu.exec(raw.trim());
  return JSON.parse(fenced?.[1] ?? raw) as unknown;
}

/**
 * What an answer says about each page of a batch of `pageCount`: its text, or null for a page whose entry is malformed.
 * The numbering is trusted only when it is exactly 1 to `pageCount`, each once, in whatever order: an answer that
 * skips a page, repeats one, runs past the batch or counts from the printed page numbers cannot be told from one that
 * is shifted, and a shifted answer would give pages the text of other pages without a word of warning. Such an answer
 * is "no usable answer" for every page (the caller asks for the pages again, alone). An entry whose lines are malformed
 * costs only its own page. A request for one page is the exception: its one entry can only be that page, so it is taken
 * whatever number the model gave it (the printed page number, say).
 */
export function pagesOfAnswer(value: unknown, pageCount: number): (string | null)[] {
  const none = Array.from({ length: pageCount }, () => null);
  if (!Array.isArray(value) || value.length !== pageCount) return none;
  if (pageCount === 1) {
    const lines = Lines.safeParse((value[0] as { lines?: unknown } | null | undefined)?.lines);
    return [lines.success ? textOfLines(lines.data) : null];
  }
  const byPage = new Map<number, unknown>();
  for (const entry of value as unknown[]) {
    const numbered = Numbered.safeParse(entry);
    if (!numbered.success || numbered.data.page < 1 || numbered.data.page > pageCount) return none;
    if (byPage.has(numbered.data.page)) return none;
    byPage.set(numbered.data.page, entry);
  }
  return Array.from({ length: pageCount }, (_, index) => {
    const lines = Lines.safeParse((byPage.get(index + 1) as { lines?: unknown } | undefined)?.lines);
    return lines.success ? textOfLines(lines.data) : null;
  });
}

/** The service answered with nothing at all: no candidate, or a candidate with no text that stopped for no reason. */
function isEmptyAnswer(response: GenerateContentResponse): boolean {
  const reason = response.promptFeedback?.blockReason;
  if (reason !== undefined && reason !== BlockedReason.BLOCKED_REASON_UNSPECIFIED) return false; // blocked: not empty
  const candidate = response.candidates?.[0];
  if (candidate === undefined) return true;
  const text = (candidate.content?.parts ?? [])
    .filter((part) => typeof part.text === 'string' && part.thought !== true)
    .map((part) => part.text ?? '')
    .join('');
  const finish = candidate.finishReason;
  const stoppedForNoReason =
    finish === undefined || finish === FinishReason.STOP || finish === FinishReason.FINISH_REASON_UNSPECIFIED;
  return text.trim() === '' && stoppedForNoReason;
}

export class GeminiOcrProvider implements OcrBatchProvider {
  readonly name = 'gemini';
  readonly input = 'pdf';
  readonly selectsLanguages = false;
  readonly pagesPerRequest: number;

  /** Set when the API refused the thinking setting: later requests leave it out. */
  private thinkingRefused = false;
  /** Set when the daily quota ran out: nothing more is asked of the service until the process restarts. */
  private dailyQuota: AppError | null = null;

  constructor(private readonly options: GeminiOcrOptions) {
    this.pagesPerRequest = Math.max(1, options.pagesPerRequest ?? 1);
  }

  /** The key is configured (that is what makes a Gemini provider at all); nothing is asked of the service. */
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  /** One page, as its own PDF (or, when that was not possible, a rendering): a batch of one. */
  async recognize(page: OcrPage, options: OcrRecognizeOptions): Promise<OcrResult> {
    const pdf = isPdfPage(page);
    const [result] = await this.recognizeBatch(
      { data: pdf ? page.pdf : page.png, mimeType: pdf ? 'application/pdf' : 'image/png', pageCount: 1 },
      options,
    );
    if (result === null || result === undefined) {
      throw new AppError('LLM_FAILED', 'The model returned no usable text for the page.', 'malformed answer');
    }
    return result;
  }

  async recognizeBatch(batch: OcrBatch, options: OcrRecognizeOptions): Promise<(OcrResult | null)[]> {
    if (batch.data.byteLength === 0) throw new OcrUnavailableError('There is no page to read.');
    if (this.dailyQuota !== null) throw this.dailyQuota;
    const response = await this.request(batch, options);
    let text: string;
    try {
      ({ text } = geminiText(response));
    } catch (error) {
      throw mapGeminiError(error); // a page the model declined to read: OUTPUT_BLOCKED, with the reason
    }
    let pages: (string | null)[];
    try {
      pages = pagesOfAnswer(parseAnswer(text), batch.pageCount);
    } catch {
      pages = Array.from({ length: batch.pageCount }, () => null); // not JSON at all
    }
    return pages.map((pageText) =>
      pageText === null
        ? null
        : { text: pageText, confidence: null, lines: [], languagesUsed: [], layout: 'page' as const },
    );
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }

  private request(batch: OcrBatch, options: OcrRecognizeOptions) {
    const data = Buffer.from(batch.data).toString('base64'); // once: a retry sends the same body
    const build = (thinking: boolean): GenerateContentParameters => ({
      model: this.options.model,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: batch.mimeType, data } },
            { text: ocrUserPrompt(batch.pageCount) },
          ],
        },
      ],
      config: {
        systemInstruction: OCR_SYSTEM_INSTRUCTION,
        temperature: 0,
        maxOutputTokens: this.options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        responseMimeType: 'application/json',
        responseJsonSchema: answerSchema(),
        safetySettings: SAFETY_SETTINGS,
        ...(thinking ? { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } } : {}),
        httpOptions: { timeout: this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS },
        ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
      },
    });
    /** The last failure said the model takes no thinking setting (a 400 that names it). */
    let refusedThinking = false;
    const attempt = async (thinking: boolean) => {
      try {
        const response = await this.options.client.models.generateContent(build(thinking));
        // No candidate, or one with no text, and no reason (not blocked, not cut off): a flake of the service, not an
        // answer; a second request usually gets one. (A page with no text is an answer: `[{page, lines: []}]`.)
        if (isEmptyAnswer(response)) throw new GeminiEmptyResponseError();
        return response;
      } catch (error) {
        if (thinking) {
          const { status, text } = parseGeminiError(error);
          refusedThinking = status === 400 && /thinking/iu.test(text);
        }
        // The SDK reports its own timeout as an abort. When the caller did not cancel, it is a timeout: worth a retry.
        if (isAbortLike(error) && options.signal?.aborted !== true) {
          const timeout = new Error('The model did not answer in time');
          timeout.name = 'TimeoutError';
          throw timeout;
        }
        throw error;
      }
    };
    const send = (thinking: boolean) =>
      withGeminiRetry(() => attempt(thinking), {
        ...OCR_RETRY,
        ...this.options.retry,
        ...(this.options.pacer === undefined ? {} : { pacer: this.options.pacer }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    return this.guarded(async () => {
      try {
        return await send(!this.thinkingRefused);
      } catch (error) {
        // A model that does not take the thinking setting answers 400: ask once more without it, and remember.
        if (refusedThinking && !this.thinkingRefused) {
          this.thinkingRefused = true;
          return send(false);
        }
        throw error;
      }
    });
  }

  /** Remembers a daily quota that ran out, so that the pages after it fail at once instead of asking again. */
  private async guarded<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (isDailyQuotaError(error)) this.dailyQuota = mapGeminiError(error);
      throw error;
    }
  }
}
