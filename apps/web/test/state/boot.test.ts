import { afterEach, describe, expect, it } from 'vitest';
import { syncDocumentSettings } from '../../src/state/boot';
import { createSettingsStore } from '../../src/state/settingsStore';

describe('syncDocumentSettings', () => {
  const root = document.createElement('html');
  const stores: ReturnType<typeof createSettingsStore>[] = [];

  function makeStore(language: string) {
    const store = createSettingsStore({ storage: null, matchMedia: null, language });
    stores.push(store);
    return store;
  }

  afterEach(() => {
    for (const store of stores.splice(0)) store.dispose();
  });

  it('sets lang, dir and the reduced-motion flag from the settings and keeps them in step', () => {
    const store = makeStore('en');
    const stop = syncDocumentSettings(store, root);
    expect(root.lang).toBe('en');
    expect(root.dir).toBe('ltr');
    expect(root.dataset.reducedMotion).toBe('false');

    store.getState().setUiLanguage('ar');
    expect(root.lang).toBe('ar');
    expect(root.dir).toBe('rtl');

    store.getState().setReducedMotion('reduce');
    expect(root.dataset.reducedMotion).toBe('true');

    stop();
    store.getState().setUiLanguage('en');
    expect(root.lang).toBe('ar'); // no longer following
  });

  it('starts from an Arabic browser language', () => {
    syncDocumentSettings(makeStore('ar-EG'), root);
    expect(root.dir).toBe('rtl');
  });
});
