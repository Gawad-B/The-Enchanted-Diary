import { createHash } from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import type { GenerateContentResponse } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import { BATCH_TIMEOUT_MS, RENDER_TIMEOUT_FACTOR, runOcrTask } from '../src/ingest/worker/ocr-task.js';
import type { OcrPageResult, OcrTask, WorkerMessage } from '../src/ingest/worker/protocol.js';
import { GeminiOcrProvider } from '../src/ocr/gemini.js';
import { isEncrypted, loadSourceDocument, pagesPdf, withoutPdfLibWarnings } from '../src/ocr/page-pdf.js';
import { extractPage } from '../src/pdf/extract-page.js';
import { closePdf, loadPdf } from '../src/pdf/load.js';
import { readFixture } from './fixtures.js';
import {
  FakeGeminiClient,
  answerFor,
  apiError,
  blockedResponse,
  dailyQuota,
  echoingClient,
} from './ocr-doubles/fake-gemini.js';
import { ocrSettings } from './ocr-doubles/settings.js';

/*
 * The OCR task of an ingestion worker thread with the Gemini provider, run in this process (the thread around it is
 * tested with the fake engines in ocr-worker.test.ts): pages are cut out of the real fixture with pdf-lib, sent a batch
 * at a time to a stand-in for the Gemini client, and every page ends as one `ocr-page` or one `ocr-page-error` message.
 */

const settings = ocrSettings({ provider: 'gemini', pagesPerRequest: 8 });
const fast = { sleep: () => Promise.resolve(), random: () => 0.5 };

const fixtures = new Map<string, Uint8Array>();
async function fixtureBytes(name: string): Promise<Uint8Array> {
  let bytes = fixtures.get(name);
  if (bytes === undefined) {
    bytes = new Uint8Array(await readFixture(name));
    fixtures.set(name, bytes);
  }
  return bytes;
}
const twelvePages = (): Promise<Uint8Array> => fixtureBytes('twelve-pages.pdf');

interface Run {
  messages: WorkerMessage[];
  pages: Map<number, OcrPageResult>;
  errors: Map<number, string>;
  /** Requests the model service could not answer: the pages they were for. */
  failedRequests: { pageNumbers: number[]; service: boolean; message: string; raw: string }[];
  quota: boolean;
  /** The curated fault of the configuration that stopped the job (a rejected key, an unknown model, a model that refuses every request). */
  configFault: string | null;
}

async function run(
  client: FakeGeminiClient,
  pages: number[],
  options: { pagesPerRequest?: number; maxRequestBytes?: number; dpi?: number; fixture?: string } = {},
): Promise<Run> {
  const messages: WorkerMessage[] = [];
  const task: OcrTask = {
    task: 'ocr',
    bytes: await fixtureBytes(options.fixture ?? 'twelve-pages.pdf'),
    settings: ocrSettings({ ...settings, dpi: options.dpi ?? 72 }),
    pages,
    languageSample: '',
    languages: null,
  };
  await runOcrTask(task, (message) => void messages.push(message), {
    createProvider: () =>
      new GeminiOcrProvider({
        client,
        model: settings.model,
        pagesPerRequest: options.pagesPerRequest ?? 8,
        retry: fast,
      }),
    ...(options.maxRequestBytes === undefined ? {} : { maxRequestBytes: options.maxRequestBytes }),
  });
  const result: Run = {
    messages,
    pages: new Map(),
    errors: new Map(),
    failedRequests: [],
    quota: false,
    configFault: null,
  };
  for (const message of messages) {
    if (message.type === 'ocr-page') result.pages.set(message.page.pageNumber, message.page);
    if (message.type === 'ocr-page-error') result.errors.set(message.pageNumber, message.message);
    if (message.type === 'ocr-quota') result.quota = true;
    if (message.type === 'ocr-config-fault') result.configFault = message.detail;
    if (message.type === 'ocr-request-failed') result.failedRequests.push(message);
  }
  return result;
}

describe('the OCR task with a document-reading provider', () => {
  it('reads pages several at a time, in batches of OCR_PAGES_PER_REQUEST, and maps each answer back to its page', async () => {
    const client = echoingClient();
    const result = await run(client, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(client.requests.map((request) => request.pageCount)).toEqual([8, 4]);
    expect([...result.pages.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(result.errors.size).toBe(0);
    expect(result.pages.get(1)?.text.text).toBe(
      'Request 1 page 1 first line\n\nRequest 1 page 1 second paragraph',
    );
    expect(result.pages.get(8)?.text.text).toContain('Request 1 page 8');
    expect(result.pages.get(9)?.text.text).toContain('Request 2 page 1'); // the 9th page is the first of the second file
    expect(result.pages.get(12)?.text.text).toContain('Request 2 page 4');
  });

  it('builds pages with page-level highlights, no confidence and no languages to choose', async () => {
    const result = await run(echoingClient(), [3]);
    const page = result.pages.get(3);
    expect(page?.confidence).toBeNull();
    expect(page?.languages).toEqual([]);
    expect(page?.text.confidence).toBeNull();
    expect(page?.text.blocks).toHaveLength(2);
    const rects = page?.text.blocks.flatMap((block) => block.lines.map((line) => line.rect)) ?? [];
    expect(rects.length).toBe(2);
    for (const rect of rects) expect(rect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(result.messages.some((message) => message.type === 'ocr-languages')).toBe(false);
    expect(result.messages[0]).toEqual({ type: 'ocr-ready', available: true });
    expect(result.messages.at(-1)).toEqual({ type: 'ocr-done' });
  });

  it('takes the pages that need OCR as they come, however far apart, and keeps their numbers', async () => {
    const client = echoingClient();
    const result = await run(client, [2, 5, 11]);
    expect(client.requests.map((request) => request.pageCount)).toEqual([3]);
    expect([...result.pages.keys()]).toEqual([2, 5, 11]);
    expect(result.pages.get(11)?.text.text).toContain('Request 1 page 3');
  });

  it('respects a smaller batch size, down to one page per request', async () => {
    const client = echoingClient();
    await run(client, [1, 2, 3, 4, 5], { pagesPerRequest: 2 });
    expect(client.requests.map((request) => request.pageCount)).toEqual([2, 2, 1]);
    const single = echoingClient();
    await run(single, [1, 2, 3], { pagesPerRequest: 1 });
    expect(single.requests.map((request) => request.pageCount)).toEqual([1, 1, 1]);
  });

  it('announces each request with room for a model to answer, before the work starts', async () => {
    const result = await run(echoingClient(), [1, 2]);
    const starts = result.messages.filter((message) => message.type === 'ocr-page-start');
    expect(starts[0]).toMatchObject({ pageNumber: 1, timeoutMs: BATCH_TIMEOUT_MS });
  });

  it('asks again, for that page alone, once, when the answer has a malformed entry for it', async () => {
    const client = new FakeGeminiClient((request, index) =>
      index === 0
        ? [
            { page: 1, lines: ['one'] },
            { page: 2, lines: 'garbled' },
            { page: 3, lines: ['three'] },
          ]
        : answerFor(Array.from({ length: request.pageCount }, () => ['second try'])),
    );
    const result = await run(client, [4, 5, 6]);
    expect(client.requests.map((request) => request.pageCount)).toEqual([3, 1]);
    expect(result.pages.get(4)?.text.text).toBe('one');
    expect(result.pages.get(5)?.text.text).toBe('second try');
    expect(result.pages.get(6)?.text.text).toBe('three');
    expect(result.errors.size).toBe(0);
  });

  it('asks for every page alone when the numbering of the answer cannot be trusted, and no page gets the text of another', async () => {
    // pages 4 to 7 as the model numbered them from the printed page numbers: 4, 5, 6, 7 instead of 1 to 4
    const client = new FakeGeminiClient((request) =>
      request.pageCount === 4
        ? [4, 5, 6, 7].map((page) => ({ page, lines: [`wrongly placed ${String(page)}`] }))
        : answerFor([['alone']]),
    );
    const result = await run(client, [4, 5, 6, 7]);
    expect(client.requests.map((request) => request.pageCount)).toEqual([4, 1, 1, 1, 1]);
    expect([...result.pages.keys()]).toEqual([4, 5, 6, 7]);
    for (const page of result.pages.values()) expect(page.text.text).toBe('alone');
  });

  it('reports a page that is malformed twice as unread, with a curated reason, and goes on', async () => {
    const client = new FakeGeminiClient((request) =>
      request.pageCount === 1
        ? []
        : [{ page: 1, lines: ['one'] }, { page: 2 }, { page: 3, lines: ['three'] }],
    );
    const result = await run(client, [4, 5, 6]);
    expect(client.requests).toHaveLength(2); // the batch and one retry, not more
    expect([...result.pages.keys()]).toEqual([4, 6]);
    expect(result.errors.get(5)).toBe('the model returned no usable text for the page');
    expect(result.quota).toBe(false);
  });

  it('asks again for every page of an answer that is not JSON', async () => {
    const client = new FakeGeminiClient((request) =>
      request.pageCount === 1 ? answerFor([['alone']]) : 'Sorry, I cannot do that.',
    );
    const result = await run(client, [1, 2]);
    expect(client.requests.map((request) => request.pageCount)).toEqual([2, 1, 1]);
    expect([...result.pages.keys()]).toEqual([1, 2]);
  });

  it('records a page the model read as having no text as read, with no text', async () => {
    const client = new FakeGeminiClient(() => [{ page: 1, lines: [] }]);
    const result = await run(client, [1]);
    expect(result.pages.get(1)?.text.charCount).toBe(0);
    expect(result.errors.size).toBe(0);
  });

  it('counts a request the service could not answer once, for all its pages, curated, and carries on with the next', async () => {
    // five attempts fail (the retries are the provider's), then the service is back for the second batch
    const client = new FakeGeminiClient((request, index) =>
      index <= 4
        ? apiError(503, { status: 'UNAVAILABLE', message: 'overloaded: project secret-7' })
        : echoingAnswer(request),
    );
    const result = await run(client, [1, 2, 3, 4], { pagesPerRequest: 2 });
    expect(result.failedRequests).toHaveLength(1); // one message for the request, not one per page
    const [failed] = result.failedRequests;
    expect(failed).toMatchObject({
      pageNumbers: [1, 2],
      service: true,
      message: 'the model service was not available',
    });
    expect(failed?.raw).toContain('The model service is not available');
    expect(JSON.stringify(result.messages)).not.toContain('secret-7');
    expect(result.errors.size).toBe(0); // they are not page errors
    expect([...result.pages.keys()]).toEqual([3, 4]);
  });

  it('recovers from a 503 burst of three on the first request: the batch is read, nothing fails', async () => {
    let calls = 0;
    const client = new FakeGeminiClient((request) =>
      ++calls <= 3 ? apiError(503, { status: 'UNAVAILABLE' }) : echoingAnswer(request),
    );
    const result = await run(client, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect([...result.pages.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(result.failedRequests).toEqual([]);
    expect(result.errors.size).toBe(0);
  });

  it('fails a request the service refused, not as a service failure, and reads a refused batch page by page', async () => {
    const client = new FakeGeminiClient((request) =>
      request.pageCount > 1 ? apiError(400, { message: 'bad payload' }) : answerFor([['alone']]),
    );
    const result = await run(client, [1, 2, 3]);
    expect(client.requests.map((request) => request.pageCount)).toEqual([3, 1, 1, 1]);
    expect([...result.pages.keys()]).toEqual([1, 2, 3]);
    expect(result.failedRequests).toEqual([]);
  });

  it('stops asking when the daily quota is used up, and says so once; pages read before it stay read', async () => {
    const client = new FakeGeminiClient((request, index) =>
      index === 0 ? echoingAnswer(request) : dailyQuota(),
    );
    const result = await run(client, [1, 2, 3, 4, 5, 6], { pagesPerRequest: 2 });
    expect(client.requests).toHaveLength(2); // the second request hit the quota; nothing after it was asked
    expect([...result.pages.keys()]).toEqual([1, 2]);
    expect(result.errors.size).toBe(0); // the pages left are not errors: the host marks them "daily quota reached"
    expect(result.messages.filter((message) => message.type === 'ocr-quota')).toHaveLength(1);
    expect(result.messages.at(-1)).toEqual({ type: 'ocr-done' });
  });

  it('stops at the quota in the middle of retrying single pages too', async () => {
    const client = new FakeGeminiClient((request) =>
      request.pageCount === 1
        ? dailyQuota()
        : [{ page: 1, lines: ['one'] }, { page: 2 }, { page: 3, lines: ['three'] }],
    );
    const result = await run(client, [1, 2, 3]);
    expect(result.quota).toBe(true);
    expect([...result.pages.keys()]).toEqual([1, 3]);
    expect(client.requests).toHaveLength(2);
  });

  it('reads the pages of a refused batch one by one, so that one page cannot cost the others', async () => {
    const client = new FakeGeminiClient((request, index) => {
      if (request.pageCount > 1) return blockedResponse();
      return index === 2 ? blockedResponse() : answerFor([[`page read alone ${String(index)}`]]);
    });
    const result = await run(client, [1, 2, 3]);
    expect(client.requests.map((request) => request.pageCount)).toEqual([3, 1, 1, 1]);
    expect([...result.pages.keys()]).toEqual([1, 3]);
    expect(result.errors.get(2)).toBe('the page could not be read by OCR'); // blocked alone: that page is unread
  });

  it('splits a batch that is too big for a request, and reads on', async () => {
    const client = echoingClient();
    const first = await run(client, [1, 2, 3, 4]);
    const oneBatch = client.requests[0]?.data.byteLength ?? 0;
    expect(first.errors.size).toBe(0);
    const small = echoingClient();
    // Room for about two pages' worth: the batch of four is halved until it fits.
    const result = await run(small, [1, 2, 3, 4], { maxRequestBytes: Math.floor(oneBatch * 0.6) });
    expect(Math.max(...small.requests.map((request) => request.pageCount))).toBeLessThan(4);
    expect([...result.pages.keys()]).toEqual([1, 2, 3, 4]);
  });

  it('sends a page whose PDF is too big for a request as a rendering packed into a PDF, and reads it from that', async () => {
    const client = echoingClient();
    // The scan is a 197 KB page; at 10 DPI its rendering is a few kilobytes.
    const result = await run(client, [1], { fixture: 'scanned-en.pdf', maxRequestBytes: 100_000, dpi: 10 });
    expect(client.requests.map((request) => request.mimeType)).toEqual(['application/pdf']);
    expect(client.requests[0]?.data.byteLength).toBeLessThan(100_000);
    expect(await pagesOfSent(client.requests[0])).toMatchObject([{ imageCoverage: 1, charCount: 0 }]);
    expect(result.pages.get(1)?.text.text).toContain('Request 1 page 1');
    expect(result.errors.size).toBe(0);
  });

  it('reports a page that does not fit in a request even as a rendering, and sends nothing', async () => {
    const client = echoingClient();
    const result = await run(client, [1], { fixture: 'scanned-en.pdf', maxRequestBytes: 1_000, dpi: 72 });
    expect(client.requests).toHaveLength(0);
    expect(result.errors.get(1)).toBe('the page is too large to be sent for OCR');
  });

  it('does nothing, and says so, when the provider cannot start', async () => {
    const messages: WorkerMessage[] = [];
    await runOcrTask(
      { task: 'ocr', bytes: await twelvePages(), settings, pages: [1], languageSample: '', languages: null },
      (message) => void messages.push(message),
      {
        createProvider: () => {
          const provider = new GeminiOcrProvider({ client: echoingClient(), model: 'm', pagesPerRequest: 4 });
          provider.isAvailable = () => Promise.resolve(false);
          return provider;
        },
      },
    );
    expect(messages).toEqual([{ type: 'ocr-ready', available: false }, { type: 'ocr-done' }]);
  });
});

function echoingAnswer(request: { pageCount: number }) {
  return answerFor(Array.from({ length: request.pageCount }, (_, page) => [`page ${String(page + 1)}`]));
}

describe('a service that refuses the configuration', () => {
  it.each([
    [401, 'the key was rejected'],
    [403, 'the key was rejected'],
    [404, 'model not found'],
  ])(
    'stops the document at once on a %i, asks for nothing more, and says which fault it was',
    async (status, detail) => {
      const client = new FakeGeminiClient(() => apiError(status, { message: 'refused' }));
      const result = await run(client, [1, 2, 3, 4, 5, 6], { pagesPerRequest: 2 });
      expect(client.requests).toHaveLength(1); // one request: not retried, and the other batches are not asked for
      expect(result.configFault).toBe(detail);
      expect(result.failedRequests).toEqual([]); // not a service that is "not available": nobody is told to try again in a moment
      expect(result.errors.size).toBe(0); // the host fails the pages left with the fault
      expect(result.pages.size).toBe(0);
      expect(result.messages.filter((message) => message.type === 'ocr-config-fault')).toHaveLength(1);
      expect(result.messages.at(-1)).toEqual({ type: 'ocr-done' });
    },
  );

  it('keeps the pages it read before the key was withdrawn', async () => {
    const client = new FakeGeminiClient((request, index) =>
      index === 0 ? echoingAnswer(request) : apiError(401, { message: 'revoked' }),
    );
    const result = await run(client, [1, 2, 3, 4], { pagesPerRequest: 2 });
    expect([...result.pages.keys()]).toEqual([1, 2]);
    expect(result.configFault).toBe('the key was rejected');
  });

  it('takes a model that refuses three requests in a row (a persistent 400: no PDFs, or no JSON schema) for a fault of OCR_MODEL', async () => {
    const client = new FakeGeminiClient(() =>
      apiError(400, { message: 'Unsupported mime type: application/pdf' }),
    );
    const result = await run(client, [1, 2, 3, 4], { pagesPerRequest: 2 });
    // the batch, then its first two pages alone: three refusals, and nothing more is asked
    expect(client.requests.map((request) => request.pageCount)).toEqual([2, 1, 1]);
    expect(result.configFault).toBe('the model refuses every request (check OCR_MODEL)');
    expect([...result.errors.keys()]).toEqual([1]); // the page refused alone before the count was reached; the rest the host fails with the fault
  });

  it('does not take one bad page for that: a refusal followed by a request that is taken starts the count again', async () => {
    const client = new FakeGeminiClient((request) =>
      request.pageCount > 1 ? apiError(400, { message: 'bad page somewhere' }) : echoingAnswer(request),
    );
    const result = await run(client, [1, 2, 3, 4, 5, 6], { pagesPerRequest: 3 });
    expect([...result.pages.keys()]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.configFault).toBeNull();
    // and a page that is refused alone is reported as that page's, not the model's
    const lone = new FakeGeminiClient((request, index) =>
      request.pageCount > 1 || index === 2 ? apiError(400, { message: 'this page' }) : echoingAnswer(request),
    );
    const second = await run(lone, [1, 2, 3], { pagesPerRequest: 3 });
    expect(second.configFault).toBeNull();
    expect([...second.pages.keys()]).toEqual([1, 3]);
    expect(second.errors.get(2)).toBe('the page could not be read by OCR');
  });

  it('still calls an overloaded service a service failure: a 503 is not a fault of the configuration', async () => {
    const client = new FakeGeminiClient(() => apiError(503, { status: 'UNAVAILABLE' }));
    const result = await run(client, [1, 2]);
    expect(result.configFault).toBeNull();
    expect(result.failedRequests).toHaveLength(1);
  });

  it('treats an answer that is empty (a candidate with no text and no reason) as the service failing, once the retries are used up', async () => {
    const hollow = {
      candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
    } as unknown as GenerateContentResponse;
    const client = new FakeGeminiClient(() => hollow);
    const result = await run(client, [1, 2, 3]);
    expect(client.requests).toHaveLength(5);
    expect(result.failedRequests).toMatchObject([{ pageNumbers: [1, 2, 3], service: true }]);
    expect(result.errors.size).toBe(0); // not "no usable text" for each page, which would have been "damaged"
  });
});

describe('a document that is encrypted with an owner password only', () => {
  it('is the kind of file the cut-out copy breaks: pdf-lib copies its pages with their streams still encrypted', async () => {
    const { source, copy } = await withoutPdfLibWarnings(async () => {
      const loaded = await loadSourceDocument(await fixtureBytes('scanned-ar-locked.pdf'));
      return { source: loaded, copy: await pagesPdf(loaded, [1]) };
    });
    expect(isEncrypted(source)).toBe(true);
    // pdf.js opens the original and finds the scan; the copy has no image it can decode (this is what Gemini used to get)
    expect(await pagesOfBytes(await fixtureBytes('scanned-ar-locked.pdf'))).toMatchObject([
      { imageCoverage: 1 },
    ]);
    const [copied] = await pagesOfBytes(copy.pdf);
    expect(copied?.imageCoverage ?? 0).toBe(0);
  });

  it('is read from renderings: the PDF the model gets holds the picture of the page, not an empty page', async () => {
    const client = echoingClient();
    const result = await run(client, [1], { fixture: 'scanned-ar-locked.pdf', dpi: 100 });
    expect(client.requests).toHaveLength(1);
    const [request] = client.requests;
    expect(request?.mimeType).toBe('application/pdf');
    const [sent] = await pagesOfSent(request);
    expect(sent).toMatchObject({ imageCoverage: 1, charCount: 0 }); // the whole page is a picture
    expect(result.pages.get(1)?.text.text).toContain('Request 1 page 1');
    expect(result.errors.size).toBe(0);
    // and it is a real picture, not a blank one: decode what was packed and count the ink (the original page has about 1.1%
    // dark pixels; a blank page, which compresses to nearly the same size, has none)
    const pictures = await imageStreams(request);
    expect(pictures).toHaveLength(1);
    expect(await darkShare(pictures[0])).toBeGreaterThan(0.005);
    expect(await darkShare(await blankJpeg())).toBe(0); // the check is able to tell
  });

  it('is rendered at the resolution OCR_DPI asks for, so the ink is there at 200 DPI as well', async () => {
    const client = echoingClient();
    await run(client, [1], { fixture: 'scanned-ar-locked.pdf', dpi: 200 });
    const [picture] = await imageStreams(client.requests[0]);
    const share = await darkShare(picture);
    expect(share).toBeGreaterThan(0.005);
    expect(share).toBeLessThan(0.08); // a scan of text, not a black page
  });

  it('is the only kind of document that is rendered: an unencrypted scan is sent as the original image bytes, with no render', async () => {
    const client = echoingClient();
    const result = await run(client, [1, 2, 3], { fixture: 'scanned-three.pdf', dpi: 72 });
    expect(
      result.messages.some(
        (message) => message.type === 'ocr-page-start' && message.timeoutFactor === RENDER_TIMEOUT_FACTOR,
      ),
    ).toBe(false);
    const original = await imageStreams({ data: Buffer.from(await fixtureBytes('scanned-three.pdf')) });
    const sent = await imageStreams(client.requests[0]);
    expect(original).toHaveLength(3);
    expect(sent.map(sha256).sort()).toEqual(original.map(sha256).sort()); // byte for byte the pictures of the file
  });

  it('allows each page the time rendering needs, then the request the time the model needs', async () => {
    // pdf.js decodes the scan in JavaScript: the host is told to give the render the longer allowance, then the request its own
    const client = echoingClient();
    const result = await run(client, [1], { fixture: 'scanned-ar-locked.pdf', dpi: 72 });
    const starts = result.messages.filter((message) => message.type === 'ocr-page-start');
    expect(starts.some((message) => message.timeoutFactor === RENDER_TIMEOUT_FACTOR)).toBe(true);
    expect(starts.some((message) => message.timeoutMs === BATCH_TIMEOUT_MS)).toBe(true);
  });
});

describe('what pdf-lib says about the files it is given', () => {
  it('is never printed: the thread writes nothing to the console, and console.warn is back as it was afterwards', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // pdf-lib does complain about this file ("Invalid object ref") when it takes the encrypted page apart ...
      const loaded = await loadSourceDocument(await fixtureBytes('scanned-ar-locked.pdf'));
      await pagesPdf(loaded, [1]).catch(() => undefined);
      expect(warn.mock.calls.length).toBeGreaterThan(0);
      warn.mockClear();
      // ... and the OCR task, which touches the file with pdf-lib, keeps it to itself
      await run(echoingClient(), [1], { fixture: 'scanned-ar-locked.pdf', dpi: 72 });
      await run(echoingClient(), [1, 2], { fixture: 'scanned-three.pdf', dpi: 72 });
      expect(warn).not.toHaveBeenCalled();
      expect(console.warn).toBe(warn); // restored, not left swallowed
    } finally {
      warn.mockRestore();
    }
  });

  it('can be nested, and restores console.warn when the work throws', async () => {
    const before = console.warn;
    await expect(
      withoutPdfLibWarnings(async () => {
        await withoutPdfLibWarnings(() => Promise.resolve());
        expect(console.warn).not.toBe(before); // still swallowed: the outer work is not done
        throw new Error('the work failed');
      }),
    ).rejects.toThrow('the work failed');
    expect(console.warn).toBe(before);
  });
});

/** The pages of a PDF as pdf.js extracts them. */
async function pagesOfBytes(bytes: Uint8Array) {
  const doc = await loadPdf(new Uint8Array(bytes));
  try {
    const pages = [];
    for (let n = 1; n <= doc.numPages; n += 1) pages.push(await extractPage(doc, n));
    return pages;
  } finally {
    await closePdf(doc);
  }
}

const pagesOfSent = (request: { data: Buffer } | undefined) =>
  pagesOfBytes(request?.data ?? new Uint8Array());

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The image streams (as stored: a JPEG for a DCT-encoded one) of the PDF a request carried, in the order of the file. */
async function imageStreams(request: { data: Buffer } | undefined): Promise<Buffer[]> {
  const source = await PDFDocument.load(request?.data ?? new Uint8Array(), { ignoreEncryption: true });
  const streams: Buffer[] = [];
  for (const [, object] of source.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) {
      streams.push(Buffer.from(object.contents));
    }
  }
  return streams;
}

/** The share of pixels of a picture that are dark (below a third of full brightness). */
async function darkShare(encoded: Buffer | undefined): Promise<number> {
  const image = await loadImage(encoded ?? Buffer.alloc(0));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, image.width, image.height);
  let dark = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (((data[i] ?? 255) + (data[i + 1] ?? 255) + (data[i + 2] ?? 255)) / 3 < 85) dark += 1;
  }
  return dark / (image.width * image.height);
}

/** A white A4-ish JPEG at the size of a 100 DPI page: what a blank page looks like to the check. */
async function blankJpeg(): Promise<Buffer> {
  const canvas = createCanvas(827, 1170);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, 827, 1170);
  return canvas.encode('jpeg', 85);
}
