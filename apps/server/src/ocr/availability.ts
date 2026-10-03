import { hasGeminiKey, type GeminiClientConfig } from '../gemini/index.js';

/** Whether OCR can be used: what `/api/health`, `/api/config` and the ingestion pipeline ask. */
export interface OcrAvailability {
  /** Starts the check if it has not been made, and answers when it is done. */
  isAvailable(): Promise<boolean>;
  /** The answer if there is one; null while the engine has not been checked or the check is running. Never starts it. */
  peek(): boolean | null;
}

const DEFAULT_FAILURE_CACHE_MS = 60_000;

/**
 * Remembers the answer of an availability probe. Starting the engine takes a moment and may download a language pack,
 * so the probe must not run on every health call: a yes is kept for the life of the process, a no for a minute (a
 * pack may arrive, a broken install may be repaired), and callers that arrive while the probe runs share it.
 */
export class CachedAvailability implements OcrAvailability {
  private readonly failureCacheMs: number;
  private readonly now: () => number;
  private readonly onFailure: ((error: unknown) => void) | undefined;
  private current: { promise: Promise<boolean>; settled: boolean; ok: boolean; at: number } | null = null;

  constructor(
    private readonly probe: () => Promise<boolean>,
    options: { failureCacheMs?: number; now?: () => number; onFailure?: (error: unknown) => void } = {},
  ) {
    this.failureCacheMs = options.failureCacheMs ?? DEFAULT_FAILURE_CACHE_MS;
    this.now = options.now ?? Date.now;
    this.onFailure = options.onFailure;
  }

  peek(): boolean | null {
    return this.current?.settled === true ? this.current.ok : null;
  }

  isAvailable(): Promise<boolean> {
    const known = this.current;
    if (known !== null && (!known.settled || known.ok || this.now() - known.at < this.failureCacheMs)) {
      return known.promise;
    }
    const entry = { promise: Promise.resolve(false), settled: false, ok: false, at: this.now() };
    entry.promise = this.probe().then(
      (ok) => ok,
      (error: unknown) => {
        this.onFailure?.(error);
        return false;
      },
    );
    void entry.promise.then((ok) => {
      entry.settled = true;
      entry.ok = ok;
      entry.at = this.now();
    });
    this.current = entry;
    return entry.promise;
  }
}

/** OCR_PROVIDER=none. */
export const NO_OCR: OcrAvailability = { isAvailable: () => Promise.resolve(false), peek: () => false };

/**
 * OCR_PROVIDER=gemini: the engine is a web service, so "can it start" means "is there a key": known at once, nothing is
 * probed (a probe would spend a request of the quota), and a service that is down or out of quota shows up page by page.
 */
export const geminiKeyAvailability = (config: GeminiClientConfig): OcrAvailability => ({
  isAvailable: () => Promise.resolve(hasGeminiKey(config)),
  peek: () => hasGeminiKey(config),
});
