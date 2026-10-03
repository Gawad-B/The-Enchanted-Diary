import { setLeadLeaves } from '../../src/book/bookLayout';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDiaryBookStore, MAX_DIARY_LEAVES, sceneBookOf } from '../../src/state/diaryBook';

// These tests look at the diary's own leaves; the blank lead before them (owner direction T.4) has its own tests below.
beforeEach(() => {
  setLeadLeaves(0);
});
afterEach(() => {
  setLeadLeaves(14);
});

describe('the diary bound into the book', () => {
  it('starts with no pages and no dive', () => {
    expect(createDiaryBookStore().getState()).toMatchObject({
      leaves: 0,
      writing: false,
      page: 0,
      returnTo: null,
    });
  });

  it('keeps its pages between none and eight', () => {
    const store = createDiaryBookStore();
    store.getState().setLeaves(3);
    expect(store.getState().leaves).toBe(3);
    store.getState().setLeaves(99);
    expect(store.getState().leaves).toBe(MAX_DIARY_LEAVES);
    store.getState().setLeaves(-4);
    expect(store.getState().leaves).toBe(0);
    store.getState().setLeaves(2.7);
    expect(store.getState().leaves).toBe(3);
  });

  it('diving needs a page to write on: it makes sure there is one, and turns to it', () => {
    const store = createDiaryBookStore();
    store.getState().startWriting();
    expect(store.getState()).toMatchObject({ writing: true, leaves: 1, page: 0 });
  });

  it('diving into a diary that has pages turns to its last page, or to the one asked for', () => {
    const store = createDiaryBookStore();
    store.getState().setLeaves(4);
    store.getState().startWriting();
    expect(store.getState().page).toBe(3);
    store.getState().stopWriting();
    store.getState().startWriting(1);
    expect(store.getState().page).toBe(1);
    store.getState().startWriting(40);
    expect(store.getState().page).toBe(3);
  });

  it('the flyleaf is the writing page while the diary has none (the awaiting phase): diving there binds no leaf', () => {
    const store = createDiaryBookStore();
    store.getState().startWriting(undefined, { bindLeaf: false });
    expect(store.getState()).toMatchObject({ writing: true, leaves: 0, page: 0 });
  });

  it('turning stays on the pages that exist; a page that is wanted next is added', () => {
    const store = createDiaryBookStore();
    store.getState().setLeaves(2);
    store.getState().startWriting();
    store.getState().turnTo(0);
    expect(store.getState().page).toBe(0);
    store.getState().turnTo(5);
    expect(store.getState().page).toBe(1);
    store.getState().addPage();
    expect(store.getState()).toMatchObject({ leaves: 3, page: 1 });
    store.getState().turnTo(2);
    expect(store.getState().page).toBe(2);
  });

  it('adds no ninth page', () => {
    const store = createDiaryBookStore();
    store.getState().setLeaves(MAX_DIARY_LEAVES);
    expect(store.getState().addPage()).toBe(false);
    expect(store.getState().leaves).toBe(MAX_DIARY_LEAVES);
  });

  it('leaving by a citation remembers the page to come back to; coming back clears it', () => {
    const store = createDiaryBookStore();
    store.getState().setLeaves(3);
    store.getState().startWriting(1);
    store.getState().leaveForCitation();
    expect(store.getState()).toMatchObject({ writing: false, returnTo: 1 });
    store.getState().startWriting(store.getState().returnTo ?? undefined);
    expect(store.getState()).toMatchObject({ writing: true, page: 1, returnTo: null });
  });

  it('an ordinary leave does not offer a way back', () => {
    const store = createDiaryBookStore();
    store.getState().startWriting();
    store.getState().stopWriting();
    expect(store.getState().returnTo).toBeNull();
  });

  it('resets', () => {
    const store = createDiaryBookStore();
    store.getState().setLeaves(3);
    store.getState().startWriting();
    store.getState().setLivePage(2);
    store.getState().setMoving(true);
    store.getState().reset();
    expect(store.getState()).toMatchObject({
      leaves: 0,
      writing: false,
      page: 0,
      returnTo: null,
      livePage: null,
      moving: false,
    });
  });

  it('the page the surface lies on is given back (drawn with its ink) when the reader steps back, turns a page or leaves by a citation', () => {
    const store = createDiaryBookStore();
    store.getState().setLeaves(3);
    store.getState().startWriting(1);
    store.getState().setLivePage(1);
    store.getState().stopWriting();
    expect(store.getState().livePage).toBeNull();
    store.getState().startWriting(1);
    store.getState().setLivePage(1);
    store.getState().turnTo(2);
    expect(store.getState()).toMatchObject({ livePage: null, page: 2, moving: true });
    store.getState().setMoving(false);
    store.getState().setLivePage(2);
    store.getState().leaveForCitation();
    expect(store.getState()).toMatchObject({ livePage: null, writing: false, returnTo: 2 });
  });

  it('turning to the page it is on turns nothing, and so does not announce a movement', () => {
    const store = createDiaryBookStore();
    store.getState().setLeaves(2);
    store.getState().startWriting(1);
    store.getState().turnTo(1);
    expect(store.getState().moving).toBe(false);
  });

  it("the ribbon's page can be forgotten", () => {
    const store = createDiaryBookStore();
    store.getState().setLeaves(2);
    store.getState().startWriting(1);
    store.getState().leaveForCitation();
    store.getState().clearReturnTo();
    expect(store.getState().returnTo).toBeNull();
  });
});

describe('sceneBookOf: the book the scene shows', () => {
  it("reading the manuscript: the diary leaves are all turned, so the scene is the reader's spread plus them", () => {
    expect(sceneBookOf({ leaves: 0, writing: false, page: 0 }, 3)).toEqual({ diaryLeaves: 0, spread: 3 });
    expect(sceneBookOf({ leaves: 2, writing: false, page: 1, pdfVisible: true }, 3)).toEqual({
      diaryLeaves: 2,
      spread: 5,
    });
  });

  it('writing: the book is turned to the diary page, whatever the reader had open', () => {
    expect(sceneBookOf({ leaves: 3, writing: true, page: 1 }, 7)).toEqual({ diaryLeaves: 3, spread: 1 });
    expect(sceneBookOf({ leaves: 0, writing: true, page: 0 }, 0)).toEqual({ diaryLeaves: 0, spread: 0 });
  });

  it('never turns to a page that does not exist', () => {
    expect(sceneBookOf({ leaves: 2, writing: true, page: 9 }, 0).spread).toBe(1);
  });
});

describe('stepping back only zooms out', () => {
  it("the book rests on the diary page, writing or not; the reader's pages show only when the PDF is asked for", () => {
    expect(sceneBookOf({ leaves: 2, writing: false, page: 1 }, 7)).toEqual({ diaryLeaves: 2, spread: 1 });
    expect(sceneBookOf({ leaves: 2, writing: false, page: 1, pdfVisible: true }, 7)).toEqual({
      diaryLeaves: 2,
      spread: 9,
    });
  });
});
