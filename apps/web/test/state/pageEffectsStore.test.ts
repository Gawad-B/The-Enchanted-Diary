import { beforeEach, describe, expect, it } from 'vitest';
import { createPageEffectsStore, NO_EFFECTS, type PageEffectsStore } from '../../src/state/pageEffectsStore';

let store: PageEffectsStore;
beforeEach(() => {
  store = createPageEffectsStore();
});

describe('pageEffectsStore', () => {
  it('starts with no effects', () => {
    expect(store.getState().values).toEqual(NO_EFFECTS);
  });

  it('combines the sources by taking the maximum of each value', () => {
    store.getState().set('hover', { edgeGlow: 0.4, glow: 0.1 });
    store.getState().set('progress', { edgeGlow: 0.7 });
    store.getState().set('reveal', { glow: 0.5, inkSpread: 0.9, tremble: 0.2 });
    store.getState().set('citation', { memoryPull: 0.6 });
    expect(store.getState().values).toEqual({
      edgeGlow: 0.7,
      glow: 0.5,
      inkSpread: 0.9,
      tremble: 0.2,
      memoryPull: 0.6,
    });
  });

  it('a source keeps the values it did not mention', () => {
    store.getState().set('drag', { edgeGlow: 0.5, glow: 0.3 });
    store.getState().set('drag', { glow: 0.1 });
    expect(store.getState().sources.drag).toMatchObject({ edgeGlow: 0.5, glow: 0.1 });
  });

  it('clearing a source drops only its contribution', () => {
    store.getState().set('hover', { edgeGlow: 0.8 });
    store.getState().set('progress', { edgeGlow: 0.3 });
    expect(store.getState().values.edgeGlow).toBe(0.8);
    store.getState().clear('hover');
    expect(store.getState().values.edgeGlow).toBe(0.3);
    store.getState().clear('progress');
    expect(store.getState().values).toEqual(NO_EFFECTS);
  });

  it('clamps to 0..1 and ignores values that are not numbers', () => {
    store.getState().set('hover', { edgeGlow: 4, glow: -2, tremble: Number.NaN });
    expect(store.getState().values).toMatchObject({ edgeGlow: 1, glow: 0, tremble: 0 });
  });

  it('clearAll resets every source', () => {
    store.getState().set('hover', { edgeGlow: 1 });
    store.getState().set('reveal', { glow: 1 });
    store.getState().clearAll();
    expect(store.getState().values).toEqual(NO_EFFECTS);
    expect(store.getState().sources.hover).toEqual(NO_EFFECTS);
  });

  it('notifies subscribers with the combined values so shaders can read them without a React render', () => {
    const seen: number[] = [];
    store.subscribe((state) => seen.push(state.values.edgeGlow));
    store.getState().set('hover', { edgeGlow: 0.2 });
    store.getState().set('progress', { edgeGlow: 0.5 });
    expect(seen).toEqual([0.2, 0.5]);
  });
});
