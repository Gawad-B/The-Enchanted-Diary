import type { PublicConfig } from '@enchanted/shared';
import { createStore, useStore, type StoreApi } from 'zustand';

/** Where the server's configuration is: not answered yet, read, or not readable (the server did not answer, or not in a way that could be used). */
export type ConfigStatus = 'loading' | 'ready' | 'failed';

/** What the server says about itself (`GET /api/config`): the upload limits and whether a notice precedes the first upload. */
export interface ConfigState {
  config: PublicConfig | null;
  status: ConfigStatus;
  setConfig(config: PublicConfig | null): void;
  /** The configuration could not be read: what depends on it must fail safe (the free-tier notice is shown). */
  setFailed(): void;
}

export type ConfigStore = StoreApi<ConfigState>;

export function createConfigStore(): ConfigStore {
  return createStore<ConfigState>()((set) => ({
    config: null,
    status: 'loading',
    setConfig: (config) => {
      set({ config, status: config === null ? 'loading' : 'ready' });
    },
    setFailed: () => {
      set({ status: 'failed' });
    },
  }));
}

export const configStore = createConfigStore();

export function useConfigStore<T>(selector: (state: ConfigState) => T): T {
  return useStore(configStore, selector);
}

/**
 * Whether the notice that the model service is a free tier (which may keep what it reads) must be in front of the reader
 * before an upload: when the server says so, and, failing safe, whenever it has not (yet) said otherwise.
 */
export function freeTierNoticeApplies(state: Pick<ConfigState, 'config' | 'status'>): boolean {
  return state.status !== 'ready' || state.config?.llm.freeTierNotice === true;
}
