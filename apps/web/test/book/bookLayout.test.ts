import { describe, expect, it } from 'vitest';
import {
  clampSpread,
  coverFrame,
  facesOnSpread,
  leafFaces,
  leafFrame,
  leafCount,
  maxSpread,
  navigateNarrow,
  navigationForKey,
  sideOfPage,
  spreadForPage,
  turnedSide,
  unturnedSide,
  visibleAndNearFaces,
  type LeafFace,
  type NarrowPosition,
} from '../../src/book/bookLayout';

describe('spreads and pages', () => {
  it('maxSpread is ceil(n / 2)', () => {
    expect([0, 1, 2, 3, 4, 5, 40, 41].map(maxSpread)).toEqual([0, 1, 1, 2, 2, 3, 20, 21]);
  });

  it('spreadForPage is ceil(p / 2) for pages 1..9', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(spreadForPage)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5]);
  });

  it('spreadForPage never goes below the bookplate spread', () => {
    expect(spreadForPage(0)).toBe(0);
    expect(spreadForPage(-3)).toBe(0);
  });

  it('every leaf of a document is counted, with one trailing leaf so the last spread always has a page under it', () => {
    expect(leafCount(0)).toBe(1); // only the flyleaf
    expect(leafCount(1)).toBe(2);
    expect(leafCount(4)).toBe(3);
    expect(leafCount(5)).toBe(4);
  });
});

describe('sides', () => {
  it('the turned side is left for LTR and right for RTL, the unturned side the opposite', () => {
    expect(turnedSide('ltr')).toBe('left');
    expect(turnedSide('rtl')).toBe('right');
    expect(unturnedSide('ltr')).toBe('right');
    expect(unturnedSide('rtl')).toBe('left');
  });

  it('page 1 is on the left for LTR and on the right for RTL; even pages are on the other side', () => {
    expect([1, 2, 3, 4].map((page) => sideOfPage(page, 'ltr'))).toEqual(['left', 'right', 'left', 'right']);
    expect([1, 2, 3, 4].map((page) => sideOfPage(page, 'rtl'))).toEqual(['right', 'left', 'right', 'left']);
  });
});

describe('leafFaces', () => {
  it('leaf 0 is the flyleaf: invitation before a document, bookplate after; its back is page 1', () => {
    expect(leafFaces(0, 10, false)).toEqual({ front: 'flyleaf', back: 1 });
    expect(leafFaces(0, 10, true)).toEqual({ front: 'bookplate', back: 1 });
  });

  it('leaf j >= 1 has front page 2j and back page 2j + 1', () => {
    expect(leafFaces(1, 10, true)).toEqual({ front: 2, back: 3 });
    expect(leafFaces(4, 10, true)).toEqual({ front: 8, back: 9 });
  });

  it('faces beyond the page count are blank, including the whole flyleaf back of an empty document', () => {
    expect(leafFaces(5, 10, true)).toEqual({ front: 10, back: 'blank' });
    expect(leafFaces(6, 10, true)).toEqual({ front: 'blank', back: 'blank' });
    expect(leafFaces(0, 0, false)).toEqual({ front: 'flyleaf', back: 'blank' });
  });
});

describe('facesOnSpread', () => {
  it('spread 0 shows the endpaper on the turned side and the flyleaf on the unturned side (no document)', () => {
    expect(facesOnSpread(0, 0, 'ltr', false)).toEqual({
      left: 'endpaper',
      right: 'flyleaf',
      firstSide: 'right',
    });
    expect(facesOnSpread(0, 0, 'rtl', false)).toEqual({
      left: 'flyleaf',
      right: 'endpaper',
      firstSide: 'left',
    });
  });

  it('spread 0 shows the bookplate once a document is loaded', () => {
    expect(facesOnSpread(0, 12, 'ltr', true)).toEqual({
      left: 'endpaper',
      right: 'bookplate',
      firstSide: 'right',
    });
    expect(facesOnSpread(0, 12, 'rtl', true)).toEqual({
      left: 'bookplate',
      right: 'endpaper',
      firstSide: 'left',
    });
  });

  it('spread 1 puts page 1 on the left for LTR and on the right for RTL', () => {
    expect(facesOnSpread(1, 12, 'ltr', true)).toEqual({ left: 1, right: 2, firstSide: 'left' });
    expect(facesOnSpread(1, 12, 'rtl', true)).toEqual({ left: 2, right: 1, firstSide: 'right' });
  });

  it('spread 3 shows pages 5 and 6 in reading order in both directions', () => {
    expect(facesOnSpread(3, 12, 'ltr', true)).toEqual({ left: 5, right: 6, firstSide: 'left' });
    expect(facesOnSpread(3, 12, 'rtl', true)).toEqual({ left: 6, right: 5, firstSide: 'right' });
  });

  it('an odd page count gives a blank last face on the unturned side', () => {
    expect(facesOnSpread(3, 5, 'ltr', true)).toEqual({ left: 5, right: 'blank', firstSide: 'left' });
    expect(facesOnSpread(3, 5, 'rtl', true)).toEqual({ left: 'blank', right: 5, firstSide: 'right' });
  });

  it('an even page count fills the last spread', () => {
    expect(facesOnSpread(3, 6, 'ltr', true)).toEqual({ left: 5, right: 6, firstSide: 'left' });
  });
});

describe('visibleAndNearFaces', () => {
  it('lists the two visible faces first, in reading order, then the neighbours by distance', () => {
    const faces = visibleAndNearFaces(3, 20, 1, true);
    expect(faces.slice(0, 2)).toEqual([5, 6]);
    // radius 1: spread 4 (7, 8) before spread 2 (3, 4): looking ahead is the likelier move.
    expect(faces).toEqual([5, 6, 7, 8, 3, 4]);
  });

  it('radius 2 continues outwards, nearest spreads first, forward before backward', () => {
    expect(visibleAndNearFaces(5, 40, 2, true)).toEqual([9, 10, 11, 12, 7, 8, 13, 14, 5, 6]);
  });

  it('never repeats a face and never lists faces beyond the book', () => {
    const faces = visibleAndNearFaces(1, 3, 3, true);
    expect(new Set(faces).size).toBe(faces.length);
    for (const face of faces) {
      if (typeof face === 'number') expect(face).toBeLessThanOrEqual(3);
    }
  });

  it('includes the bookplate and endpaper faces near spread 0 and the blank face at the end', () => {
    expect(visibleAndNearFaces(0, 4, 1, true)).toEqual(['bookplate', 'endpaper', 1, 2]);
    expect(visibleAndNearFaces(2, 3, 1, true)).toEqual([3, 'blank', 1, 2]);
  });

  it('radius 0 lists only the visible faces, in reading order (odd page first, whichever side it is on)', () => {
    expect(visibleAndNearFaces(2, 20, 0, true)).toEqual([3, 4]);
  });
});

describe('navigationForKey', () => {
  it('LTR: ArrowRight and PageDown go forward, ArrowLeft and PageUp go back', () => {
    expect(navigationForKey('ArrowRight', 'ltr')).toBe('next');
    expect(navigationForKey('PageDown', 'ltr')).toBe('next');
    expect(navigationForKey('ArrowLeft', 'ltr')).toBe('prev');
    expect(navigationForKey('PageUp', 'ltr')).toBe('prev');
  });

  it('RTL: ArrowLeft and PageDown go forward, ArrowRight and PageUp go back', () => {
    expect(navigationForKey('ArrowLeft', 'rtl')).toBe('next');
    expect(navigationForKey('PageDown', 'rtl')).toBe('next');
    expect(navigationForKey('ArrowRight', 'rtl')).toBe('prev');
    expect(navigationForKey('PageUp', 'rtl')).toBe('prev');
  });

  it('Home and End are first and last in both directions', () => {
    for (const dir of ['ltr', 'rtl'] as const) {
      expect(navigationForKey('Home', dir)).toBe('first');
      expect(navigationForKey('End', dir)).toBe('last');
    }
  });

  it('any other key is not navigation', () => {
    expect(navigationForKey('a', 'ltr')).toBeNull();
    expect(navigationForKey('Enter', 'rtl')).toBeNull();
    expect(navigationForKey('ArrowUp', 'ltr')).toBeNull();
  });
});

describe('clampSpread', () => {
  it('with a document the range is 0..ceil(n / 2)', () => {
    expect(clampSpread(-4, 9, true)).toBe(0);
    expect(clampSpread(0, 9, true)).toBe(0);
    expect(clampSpread(3, 9, true)).toBe(3);
    expect(clampSpread(5, 9, true)).toBe(5);
    expect(clampSpread(6, 9, true)).toBe(5);
    expect(clampSpread(99, 8, true)).toBe(4);
  });

  it('without a document the only spread is 0', () => {
    expect(clampSpread(3, 9, false)).toBe(0);
    expect(clampSpread(-1, 0, false)).toBe(0);
  });

  it('rounds fractional input to a whole spread', () => {
    expect(clampSpread(2.6, 20, true)).toBe(3);
    expect(Number.isNaN(clampSpread(Number.NaN, 20, true))).toBe(false);
    expect(clampSpread(Number.NaN, 20, true)).toBe(0);
  });
});

describe('leafFrame and coverFrame', () => {
  it('LTR: hinge on the left, unturned leaves extend towards +x, a turn rotates positively', () => {
    expect(leafFrame('ltr')).toEqual({
      hingeSide: 'left',
      outward: 1,
      turnSign: 1,
      frontUFromSpine: true,
      backUvFlip: true,
    });
  });

  it('RTL: hinge on the right, unturned leaves extend towards -x, a turn rotates negatively', () => {
    expect(leafFrame('rtl')).toEqual({
      hingeSide: 'right',
      outward: -1,
      turnSign: -1,
      frontUFromSpine: false,
      backUvFlip: true,
    });
  });

  it('textures are never mirrored: the back face always flips u, no frame asks for a negative scale', () => {
    for (const dir of ['ltr', 'rtl'] as const) {
      expect(leafFrame(dir).backUvFlip).toBe(true);
      expect(Math.abs(leafFrame(dir).outward)).toBe(1);
      expect(Math.abs(leafFrame(dir).turnSign)).toBe(1);
    }
  });

  it('frames are shared immutable constants: asking for one every frame allocates nothing', () => {
    for (const dir of ['ltr', 'rtl'] as const) {
      expect(leafFrame(dir)).toBe(leafFrame(dir));
      expect(coverFrame(dir)).toBe(coverFrame(dir));
      expect(Object.isFrozen(leafFrame(dir))).toBe(true);
      expect(Object.isFrozen(coverFrame(dir))).toBe(true);
    }
    expect(leafFrame('ltr')).not.toBe(leafFrame('rtl'));
  });

  it('the cover frame follows the leaf frame and is declared symmetric under a half turn', () => {
    for (const dir of ['ltr', 'rtl'] as const) {
      const cover = coverFrame(dir);
      const leaf = leafFrame(dir);
      expect(cover.hingeSide).toBe(leaf.hingeSide);
      expect(cover.outward).toBe(leaf.outward);
      expect(cover.turnSign).toBe(leaf.turnSign);
      expect(cover.c2Symmetric).toBe(true);
    }
  });

  it('the turn sign is consistent with the hinge side: the leaf swings over the gutter to the other side', () => {
    // A point at distance s from the hinge, rotated by pi about the hinge axis, lands at -outward * s.
    for (const dir of ['ltr', 'rtl'] as const) {
      const frame = leafFrame(dir);
      const s = 1;
      const angle = Math.PI * frame.turnSign;
      // Rotation about z: x' = x cos a - y sin a; y' = x sin a + y cos a. Start (outward * s, 0).
      const x = frame.outward * s * Math.cos(angle);
      const y = frame.outward * s * Math.sin(angle);
      expect(x).toBeCloseTo(-frame.outward * s);
      expect(y).toBeCloseTo(0);
      // Halfway through the turn the leaf is above the table (y > 0): it lifts, never dives.
      const half = (Math.PI / 2) * frame.turnSign;
      expect(frame.outward * s * Math.sin(half)).toBeGreaterThan(0);
    }
  });
});

describe('navigateNarrow (one page at a time)', () => {
  const at = (spread: number, focusSide: NarrowPosition['focusSide']): NarrowPosition => ({
    spread,
    focusSide,
  });

  it('LTR walks left, right, then the next spread left', () => {
    expect(navigateNarrow(at(1, 'left'), 'next', 'ltr', 20)).toEqual(at(1, 'right'));
    expect(navigateNarrow(at(1, 'right'), 'next', 'ltr', 20)).toEqual(at(2, 'left'));
    expect(navigateNarrow(at(2, 'left'), 'prev', 'ltr', 20)).toEqual(at(1, 'right'));
    expect(navigateNarrow(at(2, 'right'), 'prev', 'ltr', 20)).toEqual(at(2, 'left'));
  });

  it('RTL walks right, left, then the next spread right', () => {
    expect(navigateNarrow(at(1, 'right'), 'next', 'rtl', 20)).toEqual(at(1, 'left'));
    expect(navigateNarrow(at(1, 'left'), 'next', 'rtl', 20)).toEqual(at(2, 'right'));
    expect(navigateNarrow(at(2, 'right'), 'prev', 'rtl', 20)).toEqual(at(1, 'left'));
    expect(navigateNarrow(at(2, 'left'), 'prev', 'rtl', 20)).toEqual(at(2, 'right'));
  });

  it('the bookplate spread has one page: next goes to page 1, prev from page 1 comes back to it', () => {
    expect(navigateNarrow(at(0, 'right'), 'next', 'ltr', 20)).toEqual(at(1, 'left'));
    expect(navigateNarrow(at(0, 'left'), 'next', 'rtl', 20)).toEqual(at(1, 'right'));
    expect(navigateNarrow(at(1, 'left'), 'prev', 'ltr', 20)).toEqual(at(0, 'right'));
    expect(navigateNarrow(at(1, 'right'), 'prev', 'rtl', 20)).toEqual(at(0, 'left'));
    expect(navigateNarrow(at(0, 'right'), 'prev', 'ltr', 20)).toEqual(at(0, 'right'));
  });

  it('stops at the last page instead of walking onto a blank face', () => {
    // 5 pages: spread 3 shows page 5 on the turned side and a blank face on the other.
    expect(navigateNarrow(at(3, 'left'), 'next', 'ltr', 5)).toEqual(at(3, 'left'));
    expect(navigateNarrow(at(3, 'right'), 'next', 'rtl', 5)).toEqual(at(3, 'right'));
    // 6 pages: page 6 is real.
    expect(navigateNarrow(at(3, 'left'), 'next', 'ltr', 6)).toEqual(at(3, 'right'));
    expect(navigateNarrow(at(3, 'right'), 'next', 'ltr', 6)).toEqual(at(3, 'right'));
  });

  it('a missing focus side means the first page of the spread', () => {
    expect(navigateNarrow(at(2, null), 'next', 'ltr', 20)).toEqual(at(2, 'right'));
    expect(navigateNarrow(at(2, null), 'next', 'rtl', 20)).toEqual(at(2, 'left'));
  });

  it('visits every page exactly once, in order, in both directions', () => {
    for (const dir of ['ltr', 'rtl'] as const) {
      const n = 7;
      const seen: LeafFace[] = [];
      let position = at(1, turnedSide(dir));
      for (let guard = 0; guard < 40; guard += 1) {
        const faces = facesOnSpread(position.spread, n, dir, true);
        seen.push(position.focusSide === 'left' ? faces.left : faces.right);
        const next = navigateNarrow(position, 'next', dir, n);
        if (next.spread === position.spread && next.focusSide === position.focusSide) break;
        position = next;
      }
      expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7]);
    }
  });
});
