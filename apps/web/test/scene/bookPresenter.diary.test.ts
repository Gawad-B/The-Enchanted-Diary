import { setLeadLeaves } from '../../src/book/bookLayout';
import { DECOR_LEAVES } from '../../src/scene/book/bookPresenter';
import { midSpread } from '../../src/scene/book/phaseRunner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBookAssets, type BookAssets } from '../../src/scene/book/bookAssets';
import { BookPresenter } from '../../src/scene/book/bookPresenter';
import { BookRig } from '../../src/scene/book/bookRig';
import { anchorStore } from '../../src/state/anchorStore';
import { diaryBookStore } from '../../src/state/diaryBook';
import { documentStore } from '../../src/state/documentStore';
import { experienceStore } from '../../src/state/experience';
import { pageEffectsStore } from '../../src/state/pageEffectsStore';
import { readerStore } from '../../src/state/readerStore';
import { resetStores } from '../components/helpers';
import { makeDocument } from '../fixtures';

/*
 * The diary's own pages in the 3D book (global section T): the presenter binds diary leaves before the flyleaf, shows the
 * manuscript exactly as before (shifted by them), and turns the book to a diary page while the reader writes.
 */

function canvas(width: number, height: number): HTMLCanvasElement {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  return element;
}

let assets: BookAssets;
let presenter: BookPresenter;
let detach: () => void;
let elapsed = 0;

function frames(seconds: number): void {
  for (let i = 0; i < Math.round(seconds * 60); i += 1) {
    presenter.frame(elapsed, 1 / 60);
    elapsed += 1 / 60;
  }
}

function manuscript(spread: number): void {
  documentStore.getState().setDocument(makeDocument({ pageCount: 10 }));
  readerStore.getState().setDocument(10, 'ltr');
  readerStore.getState().goToSpread(spread);
  // These tests are about the reader's pages: the PDF is on show (by default the book rests on the diary's page).
  diaryBookStore.getState().setPdfVisible(true);
  experienceStore.setState({ phase: 'manuscript', epoch: 5, sessionChecked: true });
  presenter = new BookPresenter({ rig: new BookRig(assets, 2), maxAirborne: 3, reducedMotion: false });
  detach = presenter.attach();
  frames(0.1);
}

const turned = (): number[] => Array.from(presenter.motion.thetas.slice(0, presenter.motion.leafCount));

beforeEach(() => {
  resetStores();
  readerStore.getState().reset();
  readerStore.getState().setNarrow(false);
  pageEffectsStore.getState().clearAll();
  documentStore.getState().reset();
  anchorStore.getState().reset();
  diaryBookStore.getState().reset();
  assets = createBookAssets('low', canvas, 1);
  elapsed = 0;
});

afterEach(() => {
  detach();
  presenter.dispose();
  assets.dispose();
  diaryBookStore.getState().reset();
});

// These tests look at the diary's own leaves; the blank lead before them (owner direction T.4) has its own tests below.
beforeEach(() => {
  setLeadLeaves(0);
});
afterEach(() => {
  setLeadLeaves(14);
});

describe('diary leaves in the book', () => {
  it('binds the leaves before the flyleaf; they are turned while the manuscript is read, so nothing that is seen changes', () => {
    manuscript(2); // reading pages 3 and 4: leaves 0 and 1 are turned
    const before = presenter.motion.spreadTarget;
    expect(before).toBe(2);
    diaryBookStore.getState().setLeaves(2);
    frames(0.1);
    expect(presenter.motion.leafCount).toBe(readerStore.getState().pageCount / 2 + 1 + 2);
    expect(presenter.motion.spreadTarget).toBe(4);
    expect(turned().slice(0, 4)).toEqual([1, 1, 1, 1]);
    expect(presenter.motion.moving).toBe(false);
  });

  it("the reader's spread is still the reader's: turning a page turns one leaf, whatever the diary holds", () => {
    manuscript(1);
    diaryBookStore.getState().setLeaves(3);
    frames(0.1);
    expect(presenter.motion.spreadTarget).toBe(4);
    readerStore.getState().goToSpread(2);
    frames(2);
    expect(presenter.motion.spreadTarget).toBe(5);
    expect(turned().slice(0, 6)).toEqual([1, 1, 1, 1, 1, 0]);
  });

  it('writing turns the book back to the diary page, and leaving turns it forward again to where the reader was', () => {
    manuscript(2);
    diaryBookStore.getState().setLeaves(2);
    frames(0.1);
    diaryBookStore.getState().startWriting(0);
    frames(3);
    expect(presenter.motion.spreadTarget).toBe(0);
    expect(turned().slice(0, 3)).toEqual([0, 0, 0]);
    diaryBookStore.getState().stopWriting();
    frames(3);
    expect(presenter.motion.spreadTarget).toBe(4);
    expect(turned().slice(0, 5)).toEqual([1, 1, 1, 1, 0]);
  });

  it('turning to the next diary page while writing turns one leaf', () => {
    manuscript(1);
    diaryBookStore.getState().setLeaves(3);
    diaryBookStore.getState().startWriting(0);
    frames(3);
    diaryBookStore.getState().turnTo(1);
    frames(2);
    expect(presenter.motion.spreadTarget).toBe(1);
    expect(turned().slice(0, 4)).toEqual([1, 0, 0, 0]);
  });

  it('a page added while writing on the last one lies unturned under it, ready to be turned to', () => {
    manuscript(1);
    diaryBookStore.getState().setLeaves(1);
    diaryBookStore.getState().startWriting(0);
    frames(3);
    expect(presenter.motion.spreadTarget).toBe(0);
    diaryBookStore.getState().addPage();
    frames(0.1);
    expect(presenter.motion.spreadTarget).toBe(0); // still on page 0
    diaryBookStore.getState().turnTo(1);
    frames(2);
    expect(presenter.motion.spreadTarget).toBe(1);
    expect(turned().slice(0, 3)).toEqual([1, 0, 0]);
  });

  it('a page cannot be bound while a leaf is in the air: it is bound as soon as the book is still', () => {
    manuscript(1);
    readerStore.getState().goToSpread(3);
    frames(0.15); // leaves are turning
    expect(presenter.motion.turning).toBe(true);
    diaryBookStore.getState().setLeaves(1);
    frames(0.05);
    expect(presenter.motion.leafCount).toBe(readerStore.getState().pageCount / 2 + 1);
    frames(3);
    expect(presenter.motion.leafCount).toBe(readerStore.getState().pageCount / 2 + 1 + 1);
    expect(presenter.motion.spreadTarget).toBe(4);
  });

  it('with no diary leaves the book is exactly as it always was', () => {
    manuscript(2);
    expect(presenter.motion.leafCount).toBe(readerStore.getState().pageCount / 2 + 1);
    expect(presenter.motion.spreadTarget).toBe(2);
  });

  it('in the awaiting phase the flyleaf is the writing page: diving binds no leaf and the book stays at spread 0', () => {
    experienceStore.setState({ phase: 'awaiting', epoch: 4, sessionChecked: true });
    presenter = new BookPresenter({ rig: new BookRig(assets, 2), maxAirborne: 3, reducedMotion: false });
    detach = presenter.attach();
    diaryBookStore.getState().startWriting(undefined, { bindLeaf: false });
    frames(1);
    expect(presenter.motion.spreadTarget).toBe(midSpread(DECOR_LEAVES)); // the upload page lies in the middle of the book
    // no document: the book is as thick as the welcome's decor, no leaf was bound for the diary
    expect(presenter.motion.leafCount).toBe(DECOR_LEAVES);
  });

  it('putting the leaves away (the conversation was cleared) takes them out of the book', () => {
    manuscript(1);
    diaryBookStore.getState().setLeaves(2);
    frames(0.1);
    expect(presenter.motion.spreadTarget).toBe(3);
    diaryBookStore.getState().setLeaves(0);
    frames(0.1);
    expect(presenter.motion.leafCount).toBe(readerStore.getState().pageCount / 2 + 1);
    expect(presenter.motion.spreadTarget).toBe(1);
  });

  it('the diary stands in the MIDDLE of the book: 30 blank leaves before its first page, 12 after, and the book rests on it', () => {
    setLeadLeaves(30);
    manuscript(1);
    diaryBookStore.getState().setLeaves(1);
    frames(0.1);
    expect(presenter.motion.leafCount).toBe(30 + 1 + 12 + 5 + 1);
    expect(presenter.motion.spreadTarget).toBe(30 + 1 + 12 + 1); // the reader's spread 1 after everything bound before the flyleaf
    diaryBookStore.getState().setPdfVisible(false); // the book rests on the diary's page
    frames(4);
    expect(presenter.motion.spreadTarget).toBe(30);
    expect(presenter.motion.turning).toBe(false);
  });
});
