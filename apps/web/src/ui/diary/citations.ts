import type { Citation, NormalizedRect } from '@enchanted/shared';
import { duration } from '../../motion/durations';
import { diaryBookStore, type DiaryBookStore } from '../../state/diaryBook';
import { pageEffectsStore, type PageEffectsStore } from '../../state/pageEffectsStore';
import { readerStore, type ReaderStore } from '../../state/readerStore';
import { settingsStore, type SettingsStore } from '../../state/settingsStore';

/** One annotation in the margin: a page (or a range of pages) of the book. */
export interface Chip {
  key: string;
  pageStart: number;
  pageEnd: number;
  sectionTitle: string | null;
  /** The passage to highlight on the first page of the range (page-fractions, origin top-left). */
  rects: NormalizedRect[];
  /** `cited`: the answer rests on it. `consulted`: the diary read it but did not cite it. */
  kind: 'cited' | 'consulted';
}

/** One chip per page range (the same pages cited twice are one annotation), in the order the answer cites them. */
export function chipsOf(citations: readonly Citation[]): Chip[] {
  const chips = new Map<string, Chip>();
  for (const citation of citations) {
    const key = `${String(citation.pageStart)}-${String(citation.pageEnd)}`;
    const rects = citation.highlights
      .filter((highlight) => highlight.page === citation.pageStart)
      .flatMap((highlight) => highlight.rects);
    const existing = chips.get(key);
    if (existing) {
      existing.rects.push(...rects);
      existing.sectionTitle ??= citation.sectionTitle;
    } else {
      chips.set(key, {
        key,
        pageStart: citation.pageStart,
        pageEnd: citation.pageEnd,
        sectionTitle: citation.sectionTitle,
        rects,
        kind: 'cited',
      });
    }
  }
  return [...chips.values()];
}

/** Chips for the pages the diary consulted but did not cite (ascending, each once, none that a cited chip already covers). */
export function consultedChips(pages: readonly number[], cited: readonly Chip[]): Chip[] {
  const covered = new Set(cited.flatMap((chip) => range(chip.pageStart, chip.pageEnd)));
  return [...new Set(pages)]
    .filter((page) => !covered.has(page))
    .sort((a, b) => a - b)
    .map((page) => ({
      key: `consulted-${String(page)}`,
      pageStart: page,
      pageEnd: page,
      sectionTitle: null,
      rects: [],
      kind: 'consulted' as const,
    }));
}

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(to - from + 1, 1) }, (_, index) => from + index);
}

export interface ShowDeps {
  reader?: Pick<ReaderStore, 'getState'>;
  book?: Pick<DiaryBookStore, 'getState'>;
  effects?: Pick<PageEffectsStore, 'getState'>;
  settings?: Pick<SettingsStore, 'getState'>;
}

let settleTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * A note in the margin was chosen: the camera pulls back from the diary's page, the book turns to the cited page and the
 * passage is highlighted (the PDF page source draws the glow). The diary remembers the page it was left on, so that the
 * ribbon "Return to the diary" can bring the reader back to it. The soft glow of the page is motion: it is left out under
 * reduced motion (the highlight stays, and the camera cuts instead of gliding).
 */
export function showCitation(chip: Chip, deps: ShowDeps = {}): void {
  const reader = deps.reader ?? readerStore;
  const book = deps.book ?? diaryBookStore;
  const effects = deps.effects ?? pageEffectsStore;
  const settings = deps.settings ?? settingsStore;

  // Turn first: leaving a spread clears a highlight, so the highlight goes on after the book has turned.
  reader.getState().goToPage(chip.pageStart);
  reader.getState().setHighlight(chip.pageStart, chip.rects);
  book.getState().leaveForCitation();
  if (settings.getState().reducedMotionResolved) return;
  effects.getState().set('citation', { glow: 0.55 });
  clearTimeout(settleTimer);
  settleTimer = setTimeout(
    () => {
      effects.getState().clear('citation');
    },
    duration('citationThread', false) + 400,
  );
}
