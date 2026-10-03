import { beforeEach, describe, expect, it } from 'vitest';
import { createReaderStore, type ReaderStore } from '../../src/state/readerStore';

let store: ReaderStore;
const state = () => store.getState();

beforeEach(() => {
  store = createReaderStore();
});

describe('readerStore: documents', () => {
  it('starts empty on the bookplate spread, reading left to right', () => {
    expect(state()).toMatchObject({
      direction: 'ltr',
      pageCount: 0,
      hasDocument: false,
      spread: 0,
      focusSide: null,
      narrow: false,
      highlight: null,
    });
  });

  it('setDocument stores the page count and direction and keeps the spread inside the book', () => {
    state().setDocument(10, 'rtl');
    expect(state()).toMatchObject({ pageCount: 10, hasDocument: true, direction: 'rtl', spread: 0 });
    state().goToSpread(5);
    state().setDocument(4, 'ltr');
    expect(state().spread).toBe(2);
  });

  it('an empty document is no document', () => {
    state().setDocument(0, 'ltr');
    expect(state().hasDocument).toBe(false);
  });

  it('clearDocument empties the book but keeps the direction and the screen width', () => {
    store.setState({ narrow: true });
    state().setDocument(10, 'rtl');
    state().goToPage(5);
    state().setHighlight(5, [{ x: 0, y: 0, w: 1, h: 1 }]);
    state().clearDocument();
    expect(state()).toMatchObject({
      pageCount: 0,
      hasDocument: false,
      spread: 0,
      highlight: null,
      direction: 'rtl',
      narrow: true,
    });
    expect(state().focusSide).toBe('left'); // RTL bookplate sits on the unturned (left) side
  });

  it('reset returns to the empty reader and keeps the screen width', () => {
    store.setState({ narrow: true });
    state().setDocument(10, 'rtl');
    state().reset();
    expect(state()).toMatchObject({
      pageCount: 0,
      direction: 'ltr',
      spread: 0,
      narrow: true,
      highlight: null,
    });
  });
});

describe('readerStore: navigation on wide screens', () => {
  beforeEach(() => {
    state().setDocument(9, 'ltr');
  });

  it('next and prev move one spread and stop at both ends', () => {
    state().prev();
    expect(state().spread).toBe(0);
    for (let i = 0; i < 12; i += 1) state().next();
    expect(state().spread).toBe(5); // ceil(9 / 2)
    state().prev();
    expect(state().spread).toBe(4);
  });

  it('first is spread 1 (page 1) and last is the last spread', () => {
    state().navigate('last');
    expect(state().spread).toBe(5);
    state().navigate('first');
    expect(state().spread).toBe(1);
  });

  it('goToSpread clamps', () => {
    state().goToSpread(99);
    expect(state().spread).toBe(5);
    state().goToSpread(-3);
    expect(state().spread).toBe(0);
  });

  it('goToPage opens the spread that shows the page, for both directions', () => {
    state().goToPage(1);
    expect(state().spread).toBe(1);
    state().goToPage(6);
    expect(state().spread).toBe(3);
    state().goToPage(7);
    expect(state().spread).toBe(4);
    state().goToPage(500);
    expect(state().spread).toBe(5);
    state().goToPage(0);
    expect(state().spread).toBe(1);
    expect(state().focusSide).toBeNull();
    state().setDocument(9, 'rtl');
    state().goToPage(4);
    expect(state().spread).toBe(2);
  });

  it('does nothing without a document', () => {
    state().clearDocument();
    state().next();
    state().goToPage(4);
    expect(state().spread).toBe(0);
  });
});

describe('readerStore: narrow screens show one page at a time', () => {
  beforeEach(() => {
    state().setNarrow(true);
    state().setDocument(9, 'ltr');
  });

  it('starts with the bookplate in view', () => {
    expect(state()).toMatchObject({ spread: 0, focusSide: 'right' });
  });

  it('LTR next walks page 1 (left), page 2 (right), page 3 (next spread left)', () => {
    state().next();
    expect([state().spread, state().focusSide]).toEqual([1, 'left']);
    state().next();
    expect([state().spread, state().focusSide]).toEqual([1, 'right']);
    state().next();
    expect([state().spread, state().focusSide]).toEqual([2, 'left']);
    state().prev();
    expect([state().spread, state().focusSide]).toEqual([1, 'right']);
  });

  it('RTL next walks page 1 (right), page 2 (left), page 3 (next spread right)', () => {
    state().setDocument(9, 'rtl');
    state().next();
    expect([state().spread, state().focusSide]).toEqual([1, 'right']);
    state().next();
    expect([state().spread, state().focusSide]).toEqual([1, 'left']);
    state().next();
    expect([state().spread, state().focusSide]).toEqual([2, 'right']);
  });

  it('goToPage sets the side the page is on', () => {
    state().goToPage(5);
    expect([state().spread, state().focusSide]).toEqual([3, 'left']);
    state().goToPage(6);
    expect([state().spread, state().focusSide]).toEqual([3, 'right']);
    state().setDocument(9, 'rtl');
    state().goToPage(5);
    expect([state().spread, state().focusSide]).toEqual([3, 'right']);
  });

  it('last is the last real page (page 9 on the turned side), first is page 1', () => {
    state().navigate('last');
    expect([state().spread, state().focusSide]).toEqual([5, 'left']);
    state().navigate('first');
    expect([state().spread, state().focusSide]).toEqual([1, 'left']);
  });

  it('leaving narrow mode drops the focus side', () => {
    state().setNarrow(false);
    expect(state().focusSide).toBeNull();
  });

  it('changing the direction moves the focus to the first page of the spread on the right side', () => {
    state().goToPage(5);
    state().setDirection('rtl');
    expect(state().focusSide).toBe('right');
  });
});

describe('readerStore: highlight', () => {
  it('stores page and rectangles with a token that changes on every call', () => {
    const rects = [{ x: 0.1, y: 0.2, w: 0.3, h: 0.1 }];
    state().setHighlight(4, rects);
    const first = state().highlight;
    expect(first).toMatchObject({ page: 4, rects });
    state().setHighlight(4, rects);
    expect(state().highlight?.token).not.toBe(first?.token);
    state().clearHighlight();
    expect(state().highlight).toBeNull();
  });

  it('a new document clears the highlight', () => {
    state().setDocument(5, 'ltr');
    state().setHighlight(2, []);
    state().setDocument(7, 'ltr');
    expect(state().highlight).toBeNull();
  });
});
