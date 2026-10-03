import { describe, expect, it, vi } from 'vitest';
import {
  SETTINGS_STORAGE_KEY,
  createSettingsStore,
  defaultUiLanguage,
  type SettingsEnvironment,
} from '../../src/state/settingsStore';

/** A controllable stand-in for matchMedia('(prefers-reduced-motion: reduce)'). */
function fakeMediaQuery(initial: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const query = {
    matches: initial,
    addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.add(listener),
    ),
    removeEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.delete(listener),
    ),
  };
  return {
    query: query as unknown as MediaQueryList,
    raw: query,
    change(matches: boolean) {
      query.matches = matches;
      for (const listener of listeners) listener({ matches } as MediaQueryListEvent);
    },
    listenerCount: () => listeners.size,
  };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => void data.set(key, value)),
    data,
  };
}

function environment(overrides: Partial<SettingsEnvironment> = {}): SettingsEnvironment {
  return { storage: memoryStorage(), matchMedia: null, language: 'en-US', ...overrides };
}

describe('defaults', () => {
  it('starts with auto quality, sound off, system motion, immersive view and no forced fallback', () => {
    const store = createSettingsStore(environment());
    expect(store.getState()).toMatchObject({
      quality: 'auto',
      resolvedQuality: null,
      sound: false,
      reducedMotion: 'system',
      reducedMotionResolved: false,
      view: 'immersive',
      forcedSimple: null,
      uiLanguage: 'en',
    });
  });

  it.each([
    ['ar', 'ar'],
    ['ar-EG', 'ar'],
    ['fa-IR', 'ar'],
    ['ur', 'ar'],
    ['en-GB', 'en'],
    ['fr', 'en'],
    ['he', 'en'],
    ['', 'en'],
  ])('derives the interface language of the browser language %j as %s', (language, expected) => {
    expect(defaultUiLanguage(language)).toBe(expected);
    expect(createSettingsStore(environment({ language })).getState().uiLanguage).toBe(expected);
  });
});

describe('reduced motion', () => {
  it('follows the system preference by default, including later changes', () => {
    const media = fakeMediaQuery(true);
    const store = createSettingsStore(environment({ matchMedia: () => media.query }));
    expect(store.getState()).toMatchObject({ systemReducedMotion: true, reducedMotionResolved: true });
    media.change(false);
    expect(store.getState()).toMatchObject({ systemReducedMotion: false, reducedMotionResolved: false });
    media.change(true);
    expect(store.getState().reducedMotionResolved).toBe(true);
  });

  it('lets an explicit setting override the system in both directions', () => {
    const media = fakeMediaQuery(true);
    const store = createSettingsStore(environment({ matchMedia: () => media.query }));
    store.getState().setReducedMotion('no-preference');
    expect(store.getState().reducedMotionResolved).toBe(false);
    media.change(false);
    store.getState().setReducedMotion('reduce');
    expect(store.getState().reducedMotionResolved).toBe(true);
    media.change(true);
    expect(store.getState().reducedMotionResolved).toBe(true);
    store.getState().setReducedMotion('system');
    expect(store.getState().reducedMotionResolved).toBe(true);
    media.change(false);
    expect(store.getState().reducedMotionResolved).toBe(false);
  });

  it('stops listening when disposed', () => {
    const media = fakeMediaQuery(false);
    const store = createSettingsStore(environment({ matchMedia: () => media.query }));
    expect(media.listenerCount()).toBe(1);
    store.dispose();
    expect(media.listenerCount()).toBe(0);
  });

  it('treats a missing matchMedia as no preference', () => {
    expect(createSettingsStore(environment({ matchMedia: null })).getState().reducedMotionResolved).toBe(
      false,
    );
  });
});

describe('persistence', () => {
  it('writes the chosen settings (and only those) on every change', () => {
    const storage = memoryStorage();
    const store = createSettingsStore(environment({ storage }));
    store.getState().setQuality('low');
    store.getState().setSound(true);
    store.getState().setView('simple');
    store.getState().setUiLanguage('ar');
    store.getState().setReducedMotion('reduce');
    store.getState().setResolvedQuality('medium'); // measured, never persisted
    store.getState().setForcedSimple('context lost'); // session-only
    expect(JSON.parse(storage.data.get(SETTINGS_STORAGE_KEY) ?? '{}')).toEqual({
      quality: 'low',
      sound: true,
      reducedMotion: 'reduce',
      view: 'simple',
      uiLanguage: 'ar',
    });
  });

  it('restores saved settings on the next visit, but never the forced fallback', () => {
    const storage = memoryStorage();
    const first = createSettingsStore(environment({ storage }));
    first.getState().setQuality('high');
    first.getState().setUiLanguage('ar');
    first.getState().setForcedSimple('boom');
    const second = createSettingsStore(environment({ storage }));
    expect(second.getState()).toMatchObject({
      quality: 'high',
      uiLanguage: 'ar',
      forcedSimple: null,
      resolvedQuality: null,
    });
  });

  it('lets a saved language win over the browser language', () => {
    const storage = memoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify({ uiLanguage: 'en' }) });
    expect(createSettingsStore(environment({ storage, language: 'ar' })).getState().uiLanguage).toBe('en');
  });

  it.each(['not json', '[]', '{"quality":"ultra"}', '{"sound":"yes"}', 'null'])(
    'ignores corrupt saved data %s',
    (saved) => {
      const storage = memoryStorage({ [SETTINGS_STORAGE_KEY]: saved });
      const store = createSettingsStore(environment({ storage }));
      expect(store.getState()).toMatchObject({ quality: 'auto', sound: false, view: 'immersive' });
    },
  );

  it('does not crash when storage throws on read or write', () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error('SecurityError');
      }),
      setItem: vi.fn(() => {
        throw new Error('QuotaExceededError');
      }),
    };
    const store = createSettingsStore(environment({ storage }));
    expect(() => {
      store.getState().setQuality('low');
      store.getState().setSound(true);
    }).not.toThrow();
    expect(store.getState()).toMatchObject({ quality: 'low', sound: true });
    expect(storage.setItem).toHaveBeenCalled();
  });

  it('works without any storage', () => {
    const store = createSettingsStore(environment({ storage: null }));
    store.getState().setView('simple');
    expect(store.getState().view).toBe('simple');
  });
});

describe('forced simple view', () => {
  it('is set with a reason, cleared on demand, and never persisted', () => {
    const storage = memoryStorage();
    const store = createSettingsStore(environment({ storage }));
    store.getState().setForcedSimple('The WebGL context was lost');
    expect(store.getState().forcedSimple).toEqual({ reason: 'The WebGL context was lost' });
    expect(storage.setItem).not.toHaveBeenCalled();
    store.getState().clearForcedSimple();
    expect(store.getState().forcedSimple).toBeNull();
  });
});
