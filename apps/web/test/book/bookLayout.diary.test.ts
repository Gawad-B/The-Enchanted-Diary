import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  diaryFace,
  diaryPageOf,
  facesOnSpread,
  isDiaryFace,
  leafCount,
  leafFaces,
  sceneSpreadFor,
  setLeadLeaves,
  visibleAndNearFaces,
} from '../../src/book/bookLayout';

// These tests look at the diary's own leaves; the blank lead before them (owner direction T.4) has its own tests below.
beforeEach(() => {
  setLeadLeaves(0);
});
afterEach(() => {
  setLeadLeaves(14);
});

describe('the diary pages bound at the front of the book', () => {
  it('names a diary page, and tells a diary face from every other face', () => {
    expect(diaryFace(0)).toBe('diary:0');
    expect(diaryFace(7)).toBe('diary:7');
    expect(isDiaryFace('diary:3')).toBe(true);
    expect(isDiaryFace('flyleaf')).toBe(false);
    expect(isDiaryFace(4)).toBe(false);
    expect(diaryPageOf('diary:5')).toBe(5);
    expect(diaryPageOf('blank')).toBeNull();
    expect(diaryPageOf(2)).toBeNull();
  });

  it('with no diary leaves nothing changes: the same leaf count and the same faces', () => {
    expect(leafCount(5)).toBe(4);
    expect(leafCount(5, 0)).toBe(4);
    expect(leafFaces(0, 5, true)).toEqual({ front: 'bookplate', back: 1 });
    expect(leafFaces(0, 5, true, 0)).toEqual({ front: 'bookplate', back: 1 });
    expect(facesOnSpread(0, 5, 'ltr', true, 0)).toEqual({
      left: 'endpaper',
      right: 'bookplate',
      firstSide: 'right',
    });
  });

  it('diary leaves come first: the leaf count grows by them', () => {
    expect(leafCount(5, 3)).toBe(7);
    expect(leafCount(0, 2)).toBe(3);
  });

  it('a diary leaf has its page on the front and a blank back; the flyleaf and the pages follow them', () => {
    expect(leafFaces(0, 5, true, 2)).toEqual({ front: 'diary:0', back: 'blank' });
    expect(leafFaces(1, 5, true, 2)).toEqual({ front: 'diary:1', back: 'blank' });
    expect(leafFaces(2, 5, true, 2)).toEqual({ front: 'bookplate', back: 1 });
    expect(leafFaces(3, 5, true, 2)).toEqual({ front: 2, back: 3 });
    expect(leafFaces(4, 5, true, 2)).toEqual({ front: 4, back: 5 });
  });

  it("the scene spread is the diary leaves plus the reader's spread", () => {
    expect(sceneSpreadFor(0, 0)).toBe(0);
    expect(sceneSpreadFor(3, 2)).toBe(5);
  });

  describe('what is visible on each side, LTR (binding on the left, diary page on the right)', () => {
    it('the book opened at the front: the endpaper, and the first diary page', () => {
      expect(facesOnSpread(0, 5, 'ltr', true, 2)).toEqual({
        left: 'endpaper',
        right: 'diary:0',
        firstSide: 'right',
      });
    });

    it('between two diary pages: the blank back of the one before, and the next page', () => {
      expect(facesOnSpread(1, 5, 'ltr', true, 2)).toEqual({
        left: 'blank',
        right: 'diary:1',
        firstSide: 'right',
      });
    });

    it('when the diary leaves are all turned, the bookplate is on the right and the last diary back on the left', () => {
      expect(facesOnSpread(2, 5, 'ltr', true, 2)).toEqual({
        left: 'blank',
        right: 'bookplate',
        firstSide: 'right',
      });
    });

    it('from there on the manuscript is exactly as it was, shifted by the diary leaves', () => {
      expect(facesOnSpread(3, 5, 'ltr', true, 2)).toEqual(facesOnSpread(1, 5, 'ltr', true));
      expect(facesOnSpread(4, 5, 'ltr', true, 2)).toEqual(facesOnSpread(2, 5, 'ltr', true));
      expect(facesOnSpread(5, 5, 'ltr', true, 2)).toEqual(facesOnSpread(3, 5, 'ltr', true));
    });
  });

  describe('what is visible on each side, RTL (binding on the right, diary page on the left)', () => {
    it('mirrors every face', () => {
      expect(facesOnSpread(0, 5, 'rtl', true, 2)).toEqual({
        left: 'diary:0',
        right: 'endpaper',
        firstSide: 'left',
      });
      expect(facesOnSpread(1, 5, 'rtl', true, 2)).toEqual({
        left: 'diary:1',
        right: 'blank',
        firstSide: 'left',
      });
      expect(facesOnSpread(2, 5, 'rtl', true, 2)).toEqual({
        left: 'bookplate',
        right: 'blank',
        firstSide: 'left',
      });
      expect(facesOnSpread(3, 5, 'rtl', true, 2)).toEqual(facesOnSpread(1, 5, 'rtl', true));
    });
  });

  it('without a document the diary pages still stand at the front (the flyleaf is the first of them while there are none)', () => {
    expect(facesOnSpread(0, 0, 'ltr', false, 0)).toEqual({
      left: 'endpaper',
      right: 'flyleaf',
      firstSide: 'right',
    });
    expect(facesOnSpread(0, 0, 'ltr', false, 1)).toEqual({
      left: 'endpaper',
      right: 'diary:0',
      firstSide: 'right',
    });
  });

  it('the faces worth a texture around a spread include the diary pages in view', () => {
    const faces = visibleAndNearFaces(0, 5, 2, true, 2);
    expect(faces.slice(0, 2)).toEqual(['diary:0', 'endpaper']);
    expect(faces).toContain('diary:1');
    // and with none, as before
    expect(visibleAndNearFaces(0, 5, 2, true)).toEqual(visibleAndNearFaces(0, 5, 2, true, 0));
    expect(visibleAndNearFaces(0, 5, 2, true).some((face) => isDiaryFace(face))).toBe(false);
  });
});

describe('the blank lead before the diary (owner direction T.4.3, T.4.6): the diary starts in the MIDDLE of the book', () => {
  it('with a diary page, 30 blank leaves stand before it, the diary page is leaf 30, then 12 blank leaves, then the flyleaf', () => {
    setLeadLeaves(30);
    expect(leafFaces(0, 10, true, 1)).toEqual({ front: 'blank', back: 'blank' });
    expect(leafFaces(29, 10, true, 1)).toEqual({ front: 'blank', back: 'blank' });
    expect(leafFaces(30, 10, true, 1)).toEqual({ front: 'diary:0', back: 'blank' });
    expect(leafFaces(31, 10, true, 1)).toEqual({ front: 'blank', back: 'blank' }); // the gap "Show me the truth" riffles through
    expect(leafFaces(30 + 1 + 12, 10, true, 1).front).toBe('bookplate');
    expect(leafCount(10, 1)).toBe(30 + 1 + 12 + 5 + 1);
  });

  it('the book stands on the diary page at spread 30, and shows nothing of the diary elsewhere', () => {
    setLeadLeaves(30);
    expect(facesOnSpread(30, 10, 'ltr', true, 1).right).toBe('diary:0');
    expect(facesOnSpread(7, 10, 'ltr', true, 1).right).toBe('blank');
    expect(facesOnSpread(31, 10, 'ltr', true, 1).right).toBe('blank');
    expect(sceneSpreadFor(2, 1)).toBe(2 + 43);
  });

  it('there is no lead without a diary page (the book is as it always was)', () => {
    setLeadLeaves(30);
    expect(leafCount(10, 0)).toBe(6);
    expect(sceneSpreadFor(3, 0)).toBe(3);
  });
});
