import { beforeEach, describe, expect, it } from 'vitest';
import { startDiaryController } from '../../src/diarypage/controller';
import { createDiaryLayoutStore } from '../../src/diarypage/service';
import type { DiaryLayout } from '../../src/diarypage/layout';
import { createDiaryBookStore } from '../../src/state/diaryBook';
import { createExperienceStore } from '../../src/state/experience';
import { createReaderStore } from '../../src/state/readerStore';
import { createFlyleafStore } from '../../src/ui/diary/flyleafStore';
import { getDraft, setDraft } from '../../src/ui/diary/quillDraft';
import type { DiaryExchange } from '../../src/diarypage/exchanges';

/* What keeps the diary's leaves and the dive in step with the experience, with its own stores. */

const layoutOf = (pageCount: number): DiaryLayout => ({
  pages: Array.from({ length: pageCount }, (_, index) => ({ index, lines: [], notes: [] })),
  spans: {},
  next: { page: pageCount - 1, row: 0 },
  pageCount,
});

function world() {
  const book = createDiaryBookStore();
  const layout = createDiaryLayoutStore();
  const experience = createExperienceStore();
  const reader = createReaderStore();
  const flyleaf = createFlyleafStore();
  reader.getState().setDocument(10, 'ltr');
  const stop = startDiaryController({ book, layout, experience, reader, flyleaf });
  const phase = (next: string, documentId: string | null = 'doc'): void => {
    experience.setState({ phase: next as never, documentId, epoch: experience.getState().epoch + 1 });
  };
  const exchanges = (count: number, pages: number): void => {
    layout.getState().set({
      layout: layoutOf(pages),
      exchanges: Array.from(
        { length: count },
        (_, index) => ({ id: `e${String(index)}` }) as unknown as DiaryExchange,
      ),
      dropped: 0,
    });
  };
  return { book, layout, experience, reader, flyleaf, stop, phase, exchanges };
}

beforeEach(() => {
  setDraft('');
});

describe('the diary controller: how many leaves the book binds for the diary', () => {
  it('one page, even blank, as soon as the manuscript is bound: the book rests on it, writing or not', () => {
    const w = world();
    w.phase('manuscript');
    expect(w.book.getState().leaves).toBe(1);
    w.book.getState().stopWriting();
    expect(w.book.getState().leaves).toBe(1);
    w.stop();
  });

  it('a leaf for every page that has writing on it, once there is writing', () => {
    const w = world();
    w.phase('manuscript');
    w.book.getState().stopWriting();
    w.exchanges(2, 3);
    expect(w.book.getState().leaves).toBe(3);
    w.exchanges(3, 5);
    expect(w.book.getState().leaves).toBe(5);
    // Clearing the conversation leaves the one page to write on.
    w.exchanges(0, 1);
    expect(w.book.getState().leaves).toBe(1);
    w.stop();
  });

  it("never more than the diary's eight", () => {
    const w = world();
    w.phase('manuscript');
    w.exchanges(9, 12);
    expect(w.book.getState().leaves).toBe(8);
    w.stop();
  });

  it('none without a manuscript bound in the book: the flyleaf is not a diary page', () => {
    const w = world();
    w.phase('awaiting', null);
    w.reader.getState().reset();
    w.exchanges(2, 3);
    expect(w.book.getState().leaves).toBe(0);
    w.book.getState().startWriting(undefined, { bindLeaf: false });
    expect(w.book.getState().leaves).toBe(0);
    expect(w.book.getState().writing).toBe(true);
    w.stop();
  });
});

describe('the diary controller: when the dive is over', () => {
  it('the reveal and the memory take the stage', () => {
    for (const phase of ['revealing', 'memory']) {
      const w = world();
      w.phase('manuscript');
      w.book.getState().startWriting();
      w.phase(phase);
      expect(w.book.getState().writing, phase).toBe(false);
      w.stop();
    }
  });

  it('uploading a manuscript ends the dive on the flyleaf', () => {
    const w = world();
    w.phase('awaiting', null);
    w.book.getState().startWriting(undefined, { bindLeaf: false });
    w.phase('uploading');
    expect(w.book.getState().writing).toBe(false);
    w.stop();
  });

  it('closing the diary ends it and forgets the pages, the ribbon and the unsent words', () => {
    const w = world();
    w.phase('manuscript');
    w.exchanges(1, 2);
    w.book.getState().startWriting();
    w.book.getState().leaveForCitation();
    setDraft('half a question');
    w.phase('closing');
    expect(w.book.getState()).toMatchObject({ leaves: 0, writing: false, returnTo: null, page: 0 });
    expect(getDraft()).toBe('');
    w.stop();
  });

  it('the ribbon belongs to the manuscript: it goes with the reveal', () => {
    const w = world();
    w.phase('manuscript');
    w.exchanges(1, 1);
    w.book.getState().startWriting();
    w.book.getState().leaveForCitation();
    expect(w.book.getState().returnTo).toBe(0);
    w.phase('revealing');
    expect(w.book.getState().returnTo).toBeNull();
    w.stop();
  });

  it("the flyleaf's little conversation goes when the manuscript arrives or the diary shuts", () => {
    const w = world();
    w.phase('awaiting', null);
    w.flyleaf.getState().write('Hello?', false);
    expect(w.flyleaf.getState().current).not.toBeNull();
    w.phase('manuscript');
    expect(w.flyleaf.getState().current).toBeNull();
    w.stop();
  });
});

describe('the diary controller: after the upload the visitor simply writes', () => {
  it('dives onto the open page once, as the manuscript arrives', () => {
    const w = world();
    w.phase('unveiling');
    expect(w.book.getState().writing).toBe(false);
    w.phase('manuscript');
    expect(w.book.getState().writing).toBe(true);
    w.book.getState().stopWriting();
    w.exchanges(1, 2);
    expect(w.book.getState().writing).toBe(false);
    w.stop();
  });
});
