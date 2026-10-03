import type { Direction } from '@enchanted/shared';
import {
  maxSpread,
  navigateNarrow,
  sideOfPage,
  turnedSide,
  unturnedSide,
  type Side,
} from '../../book/bookLayout';

/*
 * What the paging controls need to know, as pure functions of the reader's position: which direction is "next", whether
 * either direction has anywhere to go, and which page(s) the indicator names. Wide screens turn a whole spread;
 * narrow screens and "Read closely" walk one page at a time (bookLayout's `navigateNarrow`).
 */

export interface Position {
  spread: number;
  pageCount: number;
  direction: Direction;
  /** The side in view when one page is shown at a time, else null. */
  focusSide: Side | null;
  /** One page at a time (a narrow screen, or "Read closely"). */
  single: boolean;
}

export interface PagingState {
  canNext: boolean;
  canPrev: boolean;
  /** The side of the book the "next" control sits on: the unturned side (the leaves come from there). */
  nextSide: Side;
  prevSide: Side;
}

export function pagingState(position: Position): PagingState {
  const { spread, pageCount, direction, focusSide, single } = position;
  const nextSide = unturnedSide(direction);
  const prevSide = turnedSide(direction);
  if (pageCount <= 0) return { canNext: false, canPrev: false, nextSide, prevSide };
  if (single) {
    const side = focusSide ?? (spread <= 0 ? unturnedSide(direction) : turnedSide(direction));
    const here = { spread, focusSide: side };
    const next = navigateNarrow(here, 'next', direction, pageCount);
    const prev = navigateNarrow(here, 'prev', direction, pageCount);
    const moved = (to: { spread: number; focusSide: Side }): boolean =>
      to.spread !== spread || to.focusSide !== side;
    return { canNext: moved(next), canPrev: moved(prev), nextSide, prevSide };
  }
  return { canNext: spread < maxSpread(pageCount), canPrev: spread > 0, nextSide, prevSide };
}

/** What the page indicator names: the bookplate, one page, or the two pages of a spread. */
export type IndicatorModel =
  | { kind: 'bookplate' }
  | { kind: 'page'; page: number; total: number }
  | { kind: 'pages'; from: number; to: number; total: number };

export function indicatorModel(position: Position): IndicatorModel {
  const { spread, pageCount, direction, focusSide, single } = position;
  if (spread <= 0) return { kind: 'bookplate' };
  const first = 2 * spread - 1;
  const second = 2 * spread;
  if (single) {
    // The page on the side in view: odd pages are on the turned side, even pages on the other.
    const side = focusSide ?? turnedSide(direction);
    const page = side === sideOfPage(first, direction) ? first : second;
    return { kind: 'page', page: Math.min(page, pageCount), total: pageCount };
  }
  // The last spread of an odd-length document has only one page.
  if (second > pageCount) return { kind: 'page', page: Math.min(first, pageCount), total: pageCount };
  return { kind: 'pages', from: first, to: second, total: pageCount };
}

/** Western, Arabic-Indic and Persian digits typed by the reader, as an integer (NaN when there are none). */
export function parsePageInput(text: string): number {
  const digits = text
    .trim()
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
  return /^\d{1,6}$/.test(digits) ? Number(digits) : Number.NaN;
}
