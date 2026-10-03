import type { Direction } from '@enchanted/shared';

export interface CaretPoint {
  /** Relative to the origin rectangle (the writing field). */
  x: number;
  y: number;
  height: number;
}

const RTL_LETTER = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}]/u;

/**
 * Where the caret is, in the field's own px (`scale` is how much the screen shows them larger or smaller), measured on the mirror layer (the textarea's own glyphs are transparent, so the nib that follows the
 * caret is drawn from the mirror's text). `offset` is a UTF-16 offset in the typed text; the mirror's text nodes hold exactly
 * that text (apart from the tail marker, which is skipped), so the offset can be walked to a text node and measured with a
 * collapsed range's neighbour character. Browsers without `Range.getClientRects` (and jsdom) give null.
 */
export function caretPoint(
  inner: HTMLElement,
  offset: number,
  origin: DOMRect,
  direction: Direction,
  scale = 1,
): CaretPoint | null {
  const range = inner.ownerDocument.createRange();
  if (typeof range.getClientRects !== 'function') return null;
  const innerBox = inner.getBoundingClientRect();
  const edge = direction === 'rtl' ? innerBox.right : innerBox.left;
  const walker = inner.ownerDocument.createTreeWalker(inner, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest('[data-tail]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const lineHeight = Number.parseFloat(getComputedStyle(inner).lineHeight) || innerBox.height;
  // The field may be laid on a page of the book (scaled and tilted on the screen): its px are the field's own.
  const at = (x: number, y: number, height: number): CaretPoint => ({
    x: (x - origin.left) / scale,
    y: (y - origin.top) / scale,
    height: height / scale,
  });

  let remaining = offset;
  let previous: Text | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (remaining <= text.data.length) {
      if (remaining === 0) {
        if (previous === null) return at(edge, innerBox.top, lineHeight);
        break; // the end of the previous node is the same place
      }
      return measure(text, remaining);
    }
    remaining -= text.data.length;
    previous = text;
  }
  if (previous === null || previous.data.length === 0) return at(edge, innerBox.top, lineHeight);
  return measure(previous, previous.data.length);

  function measure(text: Text, at_: number): CaretPoint | null {
    const character = text.data.charAt(at_ - 1);
    range.setStart(text, at_ - 1);
    range.setEnd(text, at_);
    const rects = range.getClientRects();
    const rect = rects[rects.length - 1];
    if (!rect) return null;
    if (character === '\n') return at(edge, rect.top + rect.height, rect.height);
    return at(RTL_LETTER.test(character) ? rect.left : rect.right, rect.top, rect.height);
  }
}
