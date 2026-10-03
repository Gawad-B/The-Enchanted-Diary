import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the web app and zod', () => {
  it("builds even its own schemas without zod's eval probe (a production CSP would report it)", async () => {
    let probes = 0;
    const RealFunction = Function;
    vi.stubGlobal(
      'Function',
      new Proxy(RealFunction, {
        construct(target, args: unknown[]) {
          probes += 1;
          return Reflect.construct(target, args) as object;
        },
      }),
    );
    // The modules that build schemas, imported first and in the order main.tsx would reach them: the settings
    // store has a schema of its own. If it imported zod directly it could run before the shared package.
    const { createSettingsStore } = await import('../../src/state/settingsStore');
    const { getJson } = await import('../../src/api/client');
    const { SessionDocumentResponseSchema } = await import('@enchanted/shared');

    const store = createSettingsStore({
      storage: { getItem: () => '{"quality":"low"}', setItem: () => undefined },
      matchMedia: null,
      language: 'en',
    });
    expect(store.getState().quality).toBe('low'); // parsed with the store's own schema
    expect(SessionDocumentResponseSchema.safeParse({ document: null }).success).toBe(true);
    expect(typeof getJson).toBe('function');
    expect(probes).toBe(0);
  });
});
