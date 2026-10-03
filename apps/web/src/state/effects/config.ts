import { ApiError } from '../../api/client';
import { fetchPublicConfig } from '../../api/documents';
import { configStore, type ConfigStore } from '../configStore';

/** When a configuration that could not be read is asked for again (a cold server answers a second or two late). */
export const CONFIG_RETRY_MS: readonly number[] = [500, 1000, 2000, 4000];
/** After the listed waits, a configuration that still cannot be read is asked for again this often. */
export const CONFIG_RETRY_REPEAT_MS = 5000;

export interface ConfigEffectOptions {
  fetchConfig?: (signal: AbortSignal) => ReturnType<typeof fetchPublicConfig>;
  store?: Pick<ConfigStore, 'getState'>;
  retryMs?: readonly number[];
}

/**
 * Boot: asks the server for its public configuration (upload limits, the free-tier notice) and, on a transient failure (no
 * answer, a 5xx while the API starts), asks again with a backoff (0.5 s, 1 s, 2 s, 4 s, then every 5 s). Once the listed waits
 * are used up the store is `failed` (the defaults apply and what depends on the configuration fails safe: the free-tier notice
 * is shown whatever the server would have said), and it still becomes `ready` if a later ask answers.
 */
export function startConfigEffect(options: ConfigEffectOptions = {}): () => void {
  const fetchConfig = options.fetchConfig ?? ((signal) => fetchPublicConfig(signal));
  const store = options.store ?? configStore;
  const retries = options.retryMs ?? CONFIG_RETRY_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const attempt = (number: number): void => {
    fetchConfig(controller.signal).then(
      (config) => {
        store.getState().setConfig(config);
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (import.meta.env.DEV) console.warn('[config] could not read /api/config', error);
        // Only a transient failure (no answer, 5xx) is worth asking again; anything else leaves the defaults in place.
        const transient =
          error instanceof ApiError &&
          (error.code === 'NETWORK' || (error.status !== null && error.status >= 500));
        if (!transient) {
          store.getState().setFailed();
          return;
        }
        const delay = retries[number];
        if (delay === undefined) {
          // Marked failed (the defaults apply), but still asked for again every few seconds.
          store.getState().setFailed();
        }
        timer = setTimeout(() => {
          attempt(number + 1);
        }, delay ?? CONFIG_RETRY_REPEAT_MS);
      },
    );
  };
  attempt(0);

  return () => {
    clearTimeout(timer);
    controller.abort();
  };
}
