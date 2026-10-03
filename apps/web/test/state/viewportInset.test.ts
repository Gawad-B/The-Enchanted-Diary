import { describe, expect, it } from 'vitest';
import { createViewportInsetStore } from '../../src/state/viewportInset';

describe('the viewport inset: what the on-screen keyboard covers', () => {
  it('starts with nothing covered, takes whole pixels and never less than nothing', () => {
    const store = createViewportInsetStore();
    expect(store.getState().bottomPx).toBe(0);
    store.getState().setBottom(331.6);
    expect(store.getState().bottomPx).toBe(332);
    store.getState().setBottom(-20);
    expect(store.getState().bottomPx).toBe(0);
  });

  it('tells its listeners only when the number changes', () => {
    const store = createViewportInsetStore();
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.getState().setBottom(300);
    store.getState().setBottom(300.4);
    expect(calls).toBe(1);
  });
});
