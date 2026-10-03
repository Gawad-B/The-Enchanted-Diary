import type { Citation } from '@enchanted/shared';
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { anchorStore } from '../../src/state/anchorStore';
import { diaryBookStore } from '../../src/state/diaryBook';
import { pageEffectsStore } from '../../src/state/pageEffectsStore';
import { readerStore } from '../../src/state/readerStore';
import { settingsStore } from '../../src/state/settingsStore';
import { chipsOf, consultedChips, showCitation } from '../../src/ui/diary/citations';
import { resetStores } from '../components/helpers';

const CHUNK = '5d0a3d1c-7f31-4c1e-8f7e-0d9d3a9d6b11';
const citation = (over: Partial<Citation> = {}): Citation => ({
  marker: 'S1',
  chunkId: CHUNK,
  pageStart: 12,
  pageEnd: 12,
  sectionTitle: 'The Founding',
  snippet: 'x',
  language: 'en',
  direction: 'ltr',
  highlights: [{ page: 12, rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.05 }] }],
  ...over,
});

beforeEach(() => {
  resetStores();
  readerStore.getState().reset();
  readerStore.getState().setNarrow(false); // reset keeps the screen's width
  readerStore.getState().setDocument(40, 'ltr');
  diaryBookStore.getState().reset();
  diaryBookStore.getState().setLeaves(2);
  diaryBookStore.getState().startWriting(1);
  pageEffectsStore.getState().clearAll();
  anchorStore.getState().reset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('chipsOf: one chip per page range', () => {
  it('dedupes citations of the same pages and keeps the first section title and the highlights of every one', () => {
    const chips = chipsOf([
      citation({ marker: 'S1' }),
      citation({
        marker: 'S2',
        sectionTitle: 'Other',
        highlights: [{ page: 12, rects: [{ x: 0, y: 0, w: 1, h: 0.1 }] }],
      }),
      citation({ marker: 'S3', pageStart: 12, pageEnd: 13, highlights: [] }),
    ]);
    expect(chips.map((chip) => [chip.pageStart, chip.pageEnd])).toEqual([
      [12, 12],
      [12, 13],
    ]);
    expect(chips[0]?.sectionTitle).toBe('The Founding');
    expect(chips[0]?.rects).toHaveLength(2);
  });

  it('consulted pages become chips of their own kind, and a page that was cited is not repeated', () => {
    const cited = chipsOf([citation()]);
    const consulted = consultedChips([12, 14, 14, 3], cited);
    expect(consulted.map((chip) => chip.pageStart)).toEqual([3, 14]);
    expect(consulted.every((chip) => chip.kind === 'consulted')).toBe(true);
  });
});

describe('showCitation: a note in the margin was chosen', () => {
  it('turns the book to the page and highlights the passage', () => {
    showCitation(
      chipsOf([
        citation({
          pageStart: 13,
          pageEnd: 13,
          highlights: [{ page: 13, rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.05 }] }],
        }),
      ])[0]!,
    );
    expect(readerStore.getState().spread).toBe(7); // pages 13 and 14
    expect(readerStore.getState().highlight).toMatchObject({
      page: 13,
      rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.05 }],
    });
  });

  it('the highlight is set after the turn (turning away would clear it)', () => {
    const order: string[] = [];
    const goToPage = readerStore.getState().goToPage;
    const setHighlight = readerStore.getState().setHighlight;
    readerStore.setState({
      goToPage: (page) => {
        order.push('goToPage');
        goToPage(page);
      },
      setHighlight: (page, rects) => {
        order.push('setHighlight');
        setHighlight(page, rects);
      },
    });
    showCitation(chipsOf([citation()])[0]!);
    expect(order).toEqual(['goToPage', 'setHighlight']);
    readerStore.setState({ goToPage, setHighlight });
  });

  it('pulls the camera back from the diary and remembers the page the reader was writing on', () => {
    expect(diaryBookStore.getState()).toMatchObject({ writing: true, page: 1, returnTo: null });
    showCitation(chipsOf([citation()])[0]!);
    expect(diaryBookStore.getState()).toMatchObject({ writing: false, returnTo: 1, livePage: null });
  });

  it('on a narrow screen it faces the page the passage is on', () => {
    readerStore.getState().setNarrow(true);
    showCitation(chipsOf([citation({ pageStart: 5, pageEnd: 5, highlights: [{ page: 5, rects: [] }] })])[0]!);
    expect(readerStore.getState().focusSide).toBe('left'); // page 5 is the odd page: the left of its spread
  });

  it('lets the page glow, then lets it go', () => {
    vi.useFakeTimers();
    showCitation(chipsOf([citation()])[0]!);
    expect(pageEffectsStore.getState().sources.citation.glow).toBeGreaterThan(0);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(pageEffectsStore.getState().sources.citation.glow).toBe(0);
  });

  it('under reduced motion there is no glow (the highlight itself stays)', () => {
    settingsStore.setState({ reducedMotion: 'reduce', reducedMotionResolved: true });
    showCitation(chipsOf([citation()])[0]!);
    expect(pageEffectsStore.getState().sources.citation.glow).toBe(0);
    expect(readerStore.getState().highlight?.page).toBe(12);
  });
});
