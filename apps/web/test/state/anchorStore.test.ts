import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnchorStore, type AnchorStore } from '../../src/state/anchorStore';
import { createUiRequestStore, onUiRequest, type UiRequestStore } from '../../src/state/uiRequests';

let store: AnchorStore;
beforeEach(() => {
  store = createAnchorStore();
});

describe('anchorStore', () => {
  it('starts with no rectangles and an unstable camera', () => {
    expect(store.getState().rects).toEqual({ book: null, flyleaf: null, leftPage: null, rightPage: null });
    expect(store.getState().stable).toBe(false);
  });

  it('merges rectangles by name and keeps the others', () => {
    store.getState().setRects({ book: { x: 1, y: 2, width: 3, height: 4 } });
    store.getState().setRects({ leftPage: { x: 5, y: 6, width: 7, height: 8 } });
    expect(store.getState().rects.book).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(store.getState().rects.leftPage).toEqual({ x: 5, y: 6, width: 7, height: 8 });
    expect(store.getState().rects.rightPage).toBeNull();
    store.getState().setRects({ book: null });
    expect(store.getState().rects.book).toBeNull();
  });

  it('does not notify subscribers when nothing changed', () => {
    const listener = vi.fn();
    store.getState().setRects({ book: { x: 1, y: 2, width: 3, height: 4 } });
    store.subscribe(listener);
    store.getState().setRects({ book: { x: 1, y: 2, width: 3, height: 4 } });
    store.getState().setStable(false);
    expect(listener).not.toHaveBeenCalled();
    store.getState().setStable(true);
    store.getState().setRects({ book: { x: 9, y: 2, width: 3, height: 4 } });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('knows whether the scene draws its own vignette, so the stage can drop the CSS one (never two)', () => {
    expect(store.getState().sceneVignette).toBe(false);
    store.getState().setSceneVignette(true);
    expect(store.getState().sceneVignette).toBe(true);
    store.getState().reset();
    expect(store.getState().sceneVignette).toBe(false);
  });

  it('reset forgets every rectangle', () => {
    store.getState().setRects({ book: { x: 1, y: 2, width: 3, height: 4 } });
    store.getState().setStable(true);
    store.getState().reset();
    expect(store.getState().rects.book).toBeNull();
    expect(store.getState().stable).toBe(false);
  });
});

describe('uiRequests', () => {
  let requests: UiRequestStore;
  beforeEach(() => {
    requests = createUiRequestStore();
  });

  it('calls the handler for every request made after subscribing, and only for its type', () => {
    const handler = vi.fn();
    requests.getState().request('choose-manuscript'); // before subscribing: not delivered
    const stop = onUiRequest('choose-manuscript', handler, requests);
    requests.getState().request('choose-manuscript');
    requests.getState().request('choose-manuscript');
    expect(handler).toHaveBeenCalledTimes(2);
    stop();
    requests.getState().request('choose-manuscript');
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
