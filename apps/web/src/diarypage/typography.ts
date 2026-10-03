import type { Direction } from '@enchanted/shared';

/*
 * How a diary page is written (global section T). One design page, 520 by 728 px (the proportions of a leaf of the book), on a
 * ruled grid: every line of writing sits on a row of the same height, so the pages of an old exchange look like the pages of
 * a new one. The DOM surface lays this design page onto the 3D page with a CSS matrix, and the baked texture draws the very
 * same lines with the 2D canvas, so what the reader saw written is what stays on the page.
 */

/** The design page, in CSS px (the 3D leaf's proportions: 1 to 1.4). */
export const PAGE_WIDTH = 520;
export const PAGE_HEIGHT = 728;

/** One row of writing. */
export const PITCH = 34;
/** Space above the first row and below the last. */
export const MARGIN_TOP = 66;
export const MARGIN_BOTTOM = 62;
/** The margin on the side of the binding (wider: the page sinks into the gutter) and on the fore-edge. */
export const MARGIN_BINDING = 66;
export const MARGIN_OUTER = 44;
/** Rows of writing a page holds. */
export const ROWS = Math.floor((PAGE_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM) / PITCH);
/** Where the baseline of a row is, from its top; the ruling is a little under it. */
export const BASELINE_IN_ROW = 24;
export const RULE_IN_ROW = 29;
/** A paragraph after the first, and every note, starts this far in. */
export const INDENT = 26;

export type Hand = 'question' | 'lead' | 'fair' | 'note';
/** Which set of faces a stretch of writing uses: by the script of the exchange, not the interface language. */
export type FaceSet = 'latin' | 'arabic';

const QUILL = "'La Belle Aurore', 'Aref Ruqaa', 'Segoe Script', cursive";
const REPLY_LATIN = "'Petit Formal Script', 'Aref Ruqaa', 'Brush Script MT', cursive";
const REPLY_ARABIC = "'Aref Ruqaa', 'Petit Formal Script', 'Brush Script MT', cursive";

/** The CSS font shorthand of a hand: the DOM sets it on the line, the canvas on its context, so both measure and draw alike. */
export function fontOf(hand: Hand, faces: FaceSet, bold = false): string {
  const weight = bold ? '700 ' : '';
  switch (hand) {
    case 'question':
      return `${weight}${faces === 'arabic' ? 29 : 27}px ${QUILL}`;
    // One hand for the whole page: the diary answers in the very handwriting the visitor wrote the question in.
    case 'lead':
    case 'fair':
      return `${weight}${faces === 'arabic' ? 29 : 27}px ${QUILL}`;
    case 'note':
      return faces === 'arabic' ? `${weight}21px ${REPLY_ARABIC}` : `${weight}20px ${REPLY_LATIN}`;
  }
}

/** The families to load before text is measured, with a sample of the text each is needed for. */
export function fontsToLoad(faces: FaceSet): { font: string; text: string }[] {
  const sample = faces === 'arabic' ? 'مرحبا بكم في المذكرة ١٢٣' : 'The quick brown fox, page 12 of 40';
  return (['question', 'lead', 'fair', 'note'] as const).map((hand) => ({
    font: fontOf(hand, faces),
    text: sample,
  }));
}

/** The writing column of a page: between the margin of the binding and the fore-edge, whichever side the book binds. */
export function columnOf(layout: Direction): { left: number; right: number; width: number } {
  const left = layout === 'ltr' ? MARGIN_BINDING : MARGIN_OUTER;
  const right = PAGE_WIDTH - (layout === 'ltr' ? MARGIN_OUTER : MARGIN_BINDING);
  return { left, right, width: right - left };
}

/** Where the top of a row is, on the design page. */
export const rowTop = (row: number): number => MARGIN_TOP + row * PITCH;
/** Where the baseline of a row is. */
export const baselineOf = (row: number): number => rowTop(row) + BASELINE_IN_ROW;
