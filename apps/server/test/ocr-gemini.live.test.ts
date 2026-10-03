import { normalizeForMatch } from '@enchanted/shared';
import { describe, expect, it } from 'vitest';
import { loadConfigFromEnvironment } from '../src/env-file.js';
import { ocrSettingsOf } from '../src/ingest/ocr-settings.js';
import { runOcrTask } from '../src/ingest/worker/ocr-task.js';
import type { WorkerMessage } from '../src/ingest/worker/protocol.js';
import { createOcrProvider } from '../src/ocr/provider.js';
import { isBatchProvider } from '../src/ocr/types.js';
import { loadSourceDocument, pagesPdf } from '../src/ocr/page-pdf.js';
import { readFixture } from './fixtures.js';

/*
 * ONE live smoke test of the Gemini OCR provider: page 1 of scanned-en.pdf and page 1 of scanned-ar.pdf (two requests of
 * the quota), then the Arabic scan again as a file encrypted with an owner password only, through the OCR task (a third:
 * the page is rendered and sent as a picture), with the key from GEMINI_API_KEY (the environment, or the git-ignored .env). It runs only when asked:
 *
 *   RUN_LIVE_GEMINI=1 npx vitest run test/ocr-gemini.live.test.ts
 *
 * Nothing here prints or asserts on the key. The unit tests (ocr-gemini.test.ts, ocr-batch.test.ts) cover everything else
 * against a stand-in client.
 */

const RUN = process.env.RUN_LIVE_GEMINI === '1';

const EXPECTED_EN =
  'The Lighthouse at Saltmarsh. The lighthouse at Saltmarsh was built in 1884 by a mason named Oswin Hartley, who carried every stone from the quarry on a flat wooden cart. For forty winters the lamp was tended by the keeper Marguerite Dunmore, who recorded the weather in a blue ledger.';

/** The share of the distinctive words of `expected` (4 letters or more) found in `actual`, case-insensitively. */
function wordRecall(expected: string, actual: string): number {
  const have = new Set(normalizeForMatch(actual).split(' '));
  const words = [
    ...new Set(
      normalizeForMatch(expected)
        .split(' ')
        .filter((word) => word.length >= 4),
    ),
  ];
  return words.filter((word) => have.has(word)).length / words.length;
}

describe.skipIf(!RUN)('Gemini OCR, live (three requests of the quota)', () => {
  it('reads page 1 of an English scan and page 1 of an Arabic scan', async () => {
    const config = loadConfigFromEnvironment({ ...process.env, OCR_PROVIDER: 'gemini' });
    expect(config.geminiApiKey).not.toBeNull();
    const provider = createOcrProvider(config);
    expect(provider.name).toBe('gemini');
    expect(isBatchProvider(provider)).toBe(true);
    if (!isBatchProvider(provider)) return;

    const read = async (fixture: string) => {
      const source = await loadSourceDocument(new Uint8Array(await readFixture(fixture)));
      const { pdf } = await pagesPdf(source, [1]);
      const [result] = await provider.recognizeBatch(
        { data: pdf, mimeType: 'application/pdf', pageCount: 1 },
        { languages: [] },
      );
      return result;
    };

    const english = await read('scanned-en.pdf');
    expect(english).not.toBeNull();
    expect(english?.confidence).toBeNull();
    expect(wordRecall(EXPECTED_EN, english?.text ?? '')).toBeGreaterThanOrEqual(0.8);

    const arabic = await read('scanned-ar.pdf');
    expect(arabic).not.toBeNull();
    expect(normalizeForMatch(arabic?.text ?? '')).toContain(normalizeForMatch('المرصد'));
    expect(/[؀-ۿ]/u.test(arabic?.text ?? '')).toBe(true);
    // The Arabic is the letters of the page, not a transliteration or a translation.
    expect(/[A-Za-z]{4,}/u.test(arabic?.text ?? '')).toBe(false);
  }, 120_000);

  it('reads the Arabic scan when it is encrypted with an owner password only: rendered, sent as a picture, one request', async () => {
    const config = loadConfigFromEnvironment({ ...process.env, OCR_PROVIDER: 'gemini' });
    const messages: WorkerMessage[] = [];
    await runOcrTask(
      {
        task: 'ocr',
        bytes: new Uint8Array(await readFixture('scanned-ar-locked.pdf')),
        settings: ocrSettingsOf(config),
        pages: [1],
        languageSample: '',
        languages: null,
      },
      (message) => void messages.push(message),
      { createProvider: () => createOcrProvider(config) },
    );
    expect(messages.filter((message) => message.type === 'ocr-page-error')).toEqual([]);
    const page = messages.find((message) => message.type === 'ocr-page');
    expect(page?.type).toBe('ocr-page');
    const text = page?.type === 'ocr-page' ? page.page.text.text : '';
    expect(normalizeForMatch(text)).toContain(normalizeForMatch('المرصد'));
    expect(/[A-Za-z]{4,}/u.test(text)).toBe(false);
  }, 120_000);
});
