import { afterEach, describe, expect, it } from 'vitest';
import { NARROW_BREAKPOINT_PX, startNarrowSync } from '../../src/state/narrowSync';
import { createReaderStore } from '../../src/state/readerStore';

/** A stand-in for `window`: a width and the listeners that were registered. */
function fakeWindow(innerWidth: number) {
  const listeners = new Set<() => void>();
  return {
    innerWidth,
    addEventListener: (_type: 'resize', listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: 'resize', listener: () => void) => listeners.delete(listener),
    resize(width: number) {
      this.innerWidth = width;
      for (const listener of [...listeners]) listener();
    },
    count: () => listeners.size,
  };
}

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
});

describe('startNarrowSync (the reader pages one page at a time on narrow screens)', () => {
  it('uses the same breakpoint as the camera framing', () => {
    expect(NARROW_BREAKPOINT_PX).toBe(720);
  });

  it('sets the reader narrow from the viewport width at once, without any 3D scene', () => {
    const reader = createReaderStore();
    stop = startNarrowSync(reader, fakeWindow(390));
    expect(reader.getState().narrow).toBe(true);
  });

  it('follows the viewport as it is resized across the breakpoint', () => {
    const reader = createReaderStore();
    const view = fakeWindow(1280);
    stop = startNarrowSync(reader, view);
    expect(reader.getState().narrow).toBe(false);
    view.resize(719);
    expect(reader.getState().narrow).toBe(true);
    view.resize(720);
    expect(reader.getState().narrow).toBe(false);
  });

  it('does not touch the reader when nothing changed, and detaches when stopped', () => {
    const reader = createReaderStore();
    const view = fakeWindow(1280);
    let changes = 0;
    reader.subscribe(() => {
      changes += 1;
    });
    stop = startNarrowSync(reader, view);
    view.resize(1300);
    view.resize(1400);
    expect(changes).toBe(0);
    stop();
    stop = null;
    expect(view.count()).toBe(0);
  });
});
