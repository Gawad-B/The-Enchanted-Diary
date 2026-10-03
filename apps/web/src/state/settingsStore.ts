import { z } from '@enchanted/shared';
import { createStore, useStore, type StoreApi } from 'zustand';

export type QualitySetting = 'auto' | 'high' | 'medium' | 'low';
export type ResolvedQuality = Exclude<QualitySetting, 'auto'>;
export type ReducedMotionSetting = 'system' | 'reduce' | 'no-preference';
export type ViewSetting = 'immersive' | 'simple';
export type UiLanguage = 'en' | 'ar';

export const SETTINGS_STORAGE_KEY = 'enchanted-diary.settings.v1';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
/** Interface languages that read right to left and so get the Arabic interface by default. */
const ARABIC_INTERFACE_LANGUAGES = ['ar', 'fa', 'ur'];

/** The settings people choose; these (and only these) are persisted. */
const PersistedSettingsSchema = z.object({
  quality: z.enum(['auto', 'high', 'medium', 'low']),
  sound: z.boolean(),
  reducedMotion: z.enum(['system', 'reduce', 'no-preference']),
  view: z.enum(['immersive', 'simple']),
  uiLanguage: z.enum(['en', 'ar']),
});
type PersistedSettings = z.infer<typeof PersistedSettingsSchema>;

export interface SettingsState extends PersistedSettings {
  /** The tier actually in use; the scene sets it once it has measured the device. Never persisted. */
  resolvedQuality: ResolvedQuality | null;
  /** The operating system's reduced-motion preference. */
  systemReducedMotion: boolean;
  /** `reducedMotion` with "system" resolved. This is the value the rest of the app reads. */
  reducedMotionResolved: boolean;
  /**
   * Set (for this session only, never persisted) when the immersive view failed and the simple view is
   * forced. Cleared by "Try the immersive view again".
   */
  forcedSimple: { reason: string } | null;

  setQuality(quality: QualitySetting): void;
  setResolvedQuality(quality: ResolvedQuality | null): void;
  setSound(sound: boolean): void;
  setReducedMotion(setting: ReducedMotionSetting): void;
  setView(view: ViewSetting): void;
  setUiLanguage(language: UiLanguage): void;
  setForcedSimple(reason: string): void;
  clearForcedSimple(): void;
}

/** What the store reads from the environment. Everything is injectable so tests need no globals. */
export interface SettingsEnvironment {
  /** null disables persistence. */
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** null means the system preference cannot be observed (treated as "no preference"). */
  matchMedia: ((query: string) => MediaQueryList) | null;
  language: string;
}

/** Interface language for a browser language tag: Arabic, Persian and Urdu readers get the Arabic interface. */
export function defaultUiLanguage(browserLanguage: string): UiLanguage {
  const primary = browserLanguage.toLowerCase().split(/[-_]/)[0] ?? '';
  return ARABIC_INTERFACE_LANGUAGES.includes(primary) ? 'ar' : 'en';
}

function browserStorage(): SettingsEnvironment['storage'] {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null; // merely touching localStorage can throw when site data is blocked
  }
}

/** Reads the browser environment, tolerating any of it being missing or throwing (private mode, SSR). */
export function browserSettingsEnvironment(): SettingsEnvironment {
  return {
    storage: browserStorage(),
    matchMedia:
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? (query) => window.matchMedia(query)
        : null,
    language: typeof navigator === 'undefined' ? 'en' : navigator.language,
  };
}

function readPersisted(storage: SettingsEnvironment['storage']): Partial<PersistedSettings> {
  try {
    const raw = storage?.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = PersistedSettingsSchema.partial().safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function writePersisted(storage: SettingsEnvironment['storage'], state: PersistedSettings): void {
  try {
    storage?.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        quality: state.quality,
        sound: state.sound,
        reducedMotion: state.reducedMotion,
        view: state.view,
        uiLanguage: state.uiLanguage,
      } satisfies PersistedSettings),
    );
  } catch {
    // Quota exceeded or storage blocked: settings simply do not persist.
  }
}

function resolveReducedMotion(setting: ReducedMotionSetting, system: boolean): boolean {
  return setting === 'reduce' ? true : setting === 'no-preference' ? false : system;
}

export type SettingsStore = StoreApi<SettingsState> & {
  /** Stops listening to the system reduced-motion preference. */
  dispose(): void;
};

export function createSettingsStore(
  environment: SettingsEnvironment = browserSettingsEnvironment(),
): SettingsStore {
  const saved = readPersisted(environment.storage);
  const mediaQuery = environment.matchMedia?.(REDUCED_MOTION_QUERY) ?? null;
  const systemReducedMotion = mediaQuery?.matches ?? false;
  const reducedMotion = saved.reducedMotion ?? 'system';

  const store = createStore<SettingsState>()((set, get) => {
    const persist = (): void => {
      writePersisted(environment.storage, get());
    };
    const update = (patch: Partial<SettingsState>): void => {
      set(patch);
      persist();
    };
    return {
      quality: saved.quality ?? 'auto',
      sound: saved.sound ?? false,
      reducedMotion,
      view: saved.view ?? 'immersive',
      uiLanguage: saved.uiLanguage ?? defaultUiLanguage(environment.language),
      resolvedQuality: null,
      systemReducedMotion,
      reducedMotionResolved: resolveReducedMotion(reducedMotion, systemReducedMotion),
      forcedSimple: null,

      setQuality: (quality) => {
        update({ quality });
      },
      setResolvedQuality: (resolvedQuality) => {
        set({ resolvedQuality });
      },
      setSound: (sound) => {
        update({ sound });
      },
      setReducedMotion: (setting) => {
        update({
          reducedMotion: setting,
          reducedMotionResolved: resolveReducedMotion(setting, get().systemReducedMotion),
        });
      },
      setView: (view) => {
        update({ view });
      },
      setUiLanguage: (uiLanguage) => {
        update({ uiLanguage });
      },
      setForcedSimple: (reason) => {
        set({ forcedSimple: { reason } });
      },
      clearForcedSimple: () => {
        set({ forcedSimple: null });
      },
    };
  });

  const onSystemChange = (event: MediaQueryListEvent): void => {
    store.setState({
      systemReducedMotion: event.matches,
      reducedMotionResolved: resolveReducedMotion(store.getState().reducedMotion, event.matches),
    });
  };
  mediaQuery?.addEventListener('change', onSystemChange);

  return Object.assign(store, {
    dispose: () => {
      mediaQuery?.removeEventListener('change', onSystemChange);
    },
  });
}

/** The app's settings. Created once; effects subscribe to it and components read it through the hook. */
export const settingsStore = createSettingsStore();

export function useSettingsStore<T>(selector: (state: SettingsState) => T): T {
  return useStore(settingsStore, selector);
}
