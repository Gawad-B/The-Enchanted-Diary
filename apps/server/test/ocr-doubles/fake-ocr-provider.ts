import { appendFileSync } from 'node:fs';
import type { OCRProvider, OcrPage, OcrRecognizeOptions, OcrResult } from '../../src/ocr/types.js';

/** What a test asks of the fake engine; it reaches the worker thread through the FAKE_OCR environment variable. */
export interface FakeOcrScript {
  /** The engine cannot start. */
  unavailable?: boolean;
  /** Pages whose reading throws. */
  throwOnPage?: number[];
  /** Pages whose reading never returns (the host's page timeout must stop the thread). */
  hangOnPage?: number[];
  /** Pages that grow the process by this many MB before they return (the host's memory watchdog must stop the thread). */
  hogOnPage?: Record<string, number>;
  /** Mean confidence by language set (`eng`, `ara`, `eng+ara`); 90 when absent. */
  confidence?: Record<string, number>;
  /** Every read takes this many milliseconds. */
  delayMs?: number;
  /** The text of the first line instead of "Fake page N line one" (what the language detector will see). */
  firstLine?: string;
  /** A file each page read appends "page N" to as soon as the engine starts on it: a test waits for this instead of for time. */
  enteredLog?: string;
}

/**
 * A stand-in OCR engine for tests of the pipeline around it: it returns three lines with known boxes per page. The
 * third line records the language sets asked for so far in this thread, which shows how often and in what order the
 * language trial ran. Test code only.
 */
export class FakeOcrProvider implements OCRProvider {
  readonly name = 'fake';
  readonly input = 'png';
  readonly selectsLanguages = true;
  readonly pagesPerRequest = 1;
  private readonly asked: string[] = [];

  constructor(private readonly script: FakeOcrScript = {}) {}

  isAvailable(): Promise<boolean> {
    return Promise.resolve(this.script.unavailable !== true);
  }

  async recognize(image: OcrPage, options: OcrRecognizeOptions): Promise<OcrResult> {
    if (!('png' in image)) throw new Error('the fake engine reads renderings');
    const page = options.pageNumber ?? 0;
    const key = options.languages.join('+');
    this.asked.push(key);
    if (this.script.enteredLog !== undefined)
      appendFileSync(this.script.enteredLog, `page ${String(page)}\n`);
    if (this.script.delayMs !== undefined) await new Promise((r) => setTimeout(r, this.script.delayMs));
    if (this.script.throwOnPage?.includes(page) === true) {
      throw new Error(`the fake engine failed on page ${String(page)} at /home/secret/path`);
    }
    if (this.script.hangOnPage?.includes(page) === true) {
      // A real engine that hangs still has its event loop alive; without a timer Node would end the thread.
      setInterval(() => undefined, 1000);
      await new Promise<never>(() => undefined);
    }
    const hog = this.script.hogOnPage?.[String(page)];
    if (hog !== undefined) {
      const held = Buffer.alloc(hog * 1024 * 1024, 1); // touched, so it is resident
      await new Promise((resolve) => setTimeout(resolve, 10_000)); // long enough for the host to notice
      held.fill(2);
    }
    const lines = [
      this.script.firstLine ?? `Fake page ${String(page)} line one`,
      `Fake page ${String(page)} line two`,
      `languages ${key} calls ${this.asked.join(',')}`,
    ].map((text, index) => ({
      text,
      confidence: 90,
      // Boxes at fixed fractions of the image: x from 10% to 90%, lines 3% high from 15% down, 5% apart.
      bbox: {
        x0: 0.1 * image.width,
        y0: (0.15 + 0.05 * index) * image.height,
        x1: 0.9 * image.width,
        y1: (0.18 + 0.05 * index) * image.height,
      },
    }));
    return {
      text: lines.map((line) => line.text).join('\n'),
      confidence: this.script.confidence?.[key] ?? 90,
      lines,
      languagesUsed: [...options.languages],
    };
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}
