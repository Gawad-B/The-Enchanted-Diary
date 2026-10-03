import type { Direction } from '@enchanted/shared';

/*
 * The book model (global section G): pure functions shared by the 3D book, the PDF engine, the conversation,
 * the reveal and the 2D fallback. Nothing here knows about three.js or React.
 *
 * Physical model. Leaf 0 is the flyleaf: its front face is the invitation (before a document) or the
 * bookplate (after one) and its back face is PDF page 1. Leaf j >= 1 has front page 2j and back page 2j + 1.
 * Faces beyond the page count are blank. The inside of the front cover is the endpaper.
 * Spread s is the number of turned leaves: s = 0 shows the endpaper on the turned side and the flyleaf front
 * on the unturned side; s >= 1 shows page 2s - 1 on the turned side and page 2s on the unturned side.
 *
 * LTR: binding on the left, leaves turn right to left, page 1 is on the left. RTL: the mirror image.
 */

export type Side = 'left' | 'right';
/**
 * A page of the diary bound at the front of the book (global section T): the diary's own writing pages. `diary:n` is the front
 * face of diary leaf n (its back is blank); the leaves stand before the flyleaf.
 */
export type DiaryFace = `diary:${number}`;
export type LeafFace = number | 'flyleaf' | 'bookplate' | 'endpaper' | 'blank' | DiaryFace;
export type NavigationAction = 'next' | 'prev' | 'first' | 'last';

export function diaryFace(page: number): DiaryFace {
  return `diary:${page}`;
}

export function isDiaryFace(face: LeafFace): face is DiaryFace {
  return typeof face === 'string' && face.startsWith('diary:');
}

/** The diary page a face is, or null for any other face. */
export function diaryPageOf(face: LeafFace): number | null {
  if (!isDiaryFace(face)) return null;
  const page = Number(face.slice('diary:'.length));
  return Number.isInteger(page) && page >= 0 ? page : null;
}

/**
 * The spread the scene shows for the reader's spread when `diaryLeaves` diary leaves stand before the flyleaf: the diary leaves
 * are all turned while the manuscript is read, so the scene's count of turned leaves is theirs plus the reader's.
 */
export function sceneSpreadFor(readerSpread: number, diaryLeaves: number): number {
  return readerSpread + leavesBeforeFlyleaf(diaryLeaves);
}

/**
 * Blank leaves bound before the diary's own pages (owner direction T.4.3 and T.4.6): the diary's first page is in the MIDDLE of the
 * book, not the first page, so the book riffles forward through these to reach it. They exist only once the diary has a page.
 */
export const DEFAULT_LEAD_LEAVES = 30;
let leadLeaves = DEFAULT_LEAD_LEAVES;

/** The lead as it is now (tests turn it off to look at the diary leaves alone). */
export function leadLeavesCount(): number {
  return leadLeaves;
}

/** Tests only. */
export function setLeadLeaves(count: number): void {
  leadLeaves = count;
  gapLeaves = count === 0 ? 0 : DEFAULT_GAP_LEAVES;
}

/**
 * Blank leaves between the diary's pages and the flyleaf: "Show me the truth" riffles through them to the cited page (a long, lively
 * riffle, whatever the page), and the diary is never next to the manuscript.
 */
const DEFAULT_GAP_LEAVES = 12;
let gapLeaves = DEFAULT_GAP_LEAVES;

/** How many leaves stand before the diary's own pages: the lead. */
export function leavesBeforeDiary(): number {
  return leadLeaves;
}

/** How many leaves stand before the flyleaf when the diary has `diaryLeaves` pages: the lead (blank) and the diary's own. */
export function leavesBeforeFlyleaf(diaryLeaves: number): number {
  return diaryLeaves > 0 ? leadLeaves + diaryLeaves + gapLeaves : 0;
}

/** Highest spread: `ceil(n / 2)`. */
export function maxSpread(pageCount: number): number {
  return pageCount <= 0 ? 0 : Math.ceil(pageCount / 2);
}

/** The spread on which page `p` is visible. */
export function spreadForPage(page: number): number {
  return page <= 0 ? 0 : Math.ceil(page / 2);
}

/**
 * Number of leaves a document of `pageCount` pages needs: the flyleaf plus enough leaves that the last
 * spread always has a face (possibly blank) on its unturned side, and the diary leaves bound before it (none by default).
 */
export function leafCount(pageCount: number, diaryLeaves = 0): number {
  return leavesBeforeFlyleaf(diaryLeaves) + maxSpread(pageCount) + 1;
}

/** The side the turned leaves lie on: left for LTR, right for RTL. */
export function turnedSide(direction: Direction): Side {
  return direction === 'ltr' ? 'left' : 'right';
}

export function unturnedSide(direction: Direction): Side {
  return direction === 'ltr' ? 'right' : 'left';
}

/** The side page `p` (>= 1) is on: odd pages are on the turned side of their spread, even pages on the other. */
export function sideOfPage(page: number, direction: Direction): Side {
  return page % 2 === 1 ? turnedSide(direction) : unturnedSide(direction);
}

function pageFace(page: number, pageCount: number): LeafFace {
  return page >= 1 && page <= pageCount ? page : 'blank';
}

/** The two faces of leaf `j`; the first `diaryLeaves` leaves are the diary's (front: its page, back: blank). */
export function leafFaces(
  leaf: number,
  pageCount: number,
  hasDocument: boolean,
  diaryLeaves = 0,
): { front: LeafFace; back: LeafFace } {
  const before = leavesBeforeFlyleaf(diaryLeaves);
  if (leaf < leadLeaves && before > 0) return { front: 'blank', back: 'blank' };
  if (leaf < leadLeaves + diaryLeaves && before > 0)
    return { front: diaryFace(leaf - leadLeaves), back: 'blank' };
  if (leaf < before) return { front: 'blank', back: 'blank' };
  const own = leaf - before;
  if (own === 0) {
    return { front: hasDocument ? 'bookplate' : 'flyleaf', back: pageFace(1, pageCount) };
  }
  return { front: pageFace(2 * own, pageCount), back: pageFace(2 * own + 1, pageCount) };
}

/**
 * What is visible on each side at spread `s` (the number of turned leaves, the diary's included), and which side is read first.
 * With diary leaves the first spreads show their pages on the unturned side; the manuscript then follows exactly as it does
 * without them, shifted by the number of diary leaves.
 */
export function facesOnSpread(
  spread: number,
  pageCount: number,
  direction: Direction,
  hasDocument: boolean,
  diaryLeaves = 0,
): { left: LeafFace; right: LeafFace; firstSide: Side } {
  const turned = turnedSide(direction);
  const unturned = unturnedSide(direction);
  const before = leavesBeforeFlyleaf(diaryLeaves);
  if (spread < before) {
    const bySide: Record<Side, LeafFace> = { left: 'blank', right: 'blank' };
    bySide[turned] = spread <= 0 ? 'endpaper' : 'blank';
    bySide[unturned] =
      spread >= leadLeaves && spread < leadLeaves + diaryLeaves ? diaryFace(spread - leadLeaves) : 'blank';
    return { left: bySide.left, right: bySide.right, firstSide: unturned };
  }
  const own = spread - before;
  const turnedFace: LeafFace =
    own <= 0 ? (before > 0 ? 'blank' : 'endpaper') : pageFace(2 * own - 1, pageCount);
  const unturnedFace: LeafFace =
    own <= 0 ? (hasDocument ? 'bookplate' : 'flyleaf') : pageFace(2 * own, pageCount);
  const bySide: Record<Side, LeafFace> = { left: 'blank', right: 'blank' };
  bySide[turned] = turnedFace;
  bySide[unturned] = unturnedFace;
  // At spread 0 only the flyleaf is read; from spread 1 on the turned side (odd page) is read first.
  return { left: bySide.left, right: bySide.right, firstSide: own <= 0 ? unturned : turned };
}

/** The faces of a spread in reading order (the odd page first), independent of the screen side. */
function readingOrder(
  spread: number,
  pageCount: number,
  hasDocument: boolean,
  diaryLeaves: number,
): LeafFace[] {
  const faces = facesOnSpread(spread, pageCount, 'ltr', hasDocument, diaryLeaves);
  return spread <= leavesBeforeFlyleaf(diaryLeaves) ? [faces.right, faces.left] : [faces.left, faces.right];
}

/**
 * The faces worth having a texture for, most urgent first: the two visible faces in reading order, then the
 * faces of the neighbouring spreads by distance, looking forward before looking back.
 */
export function visibleAndNearFaces(
  spread: number,
  pageCount: number,
  radius: number,
  hasDocument: boolean,
  diaryLeaves = 0,
): LeafFace[] {
  const top = leavesBeforeFlyleaf(diaryLeaves) + clampSpread(maxSpread(pageCount), pageCount, hasDocument);
  const out: LeafFace[] = [];
  const add = (target: number): void => {
    if (target < 0 || target > top) return;
    for (const face of readingOrder(target, pageCount, hasDocument, diaryLeaves)) {
      if (!out.includes(face)) out.push(face);
    }
  };
  add(spread);
  for (let distance = 1; distance <= radius; distance += 1) {
    add(spread + distance);
    add(spread - distance);
  }
  return out;
}

/** Keyboard navigation: arrows follow the screen direction of reading, Home and End jump. */
export function navigationForKey(key: string, direction: Direction): NavigationAction | null {
  switch (key) {
    case 'Home':
      return 'first';
    case 'End':
      return 'last';
    case 'PageDown':
      return 'next';
    case 'PageUp':
      return 'prev';
    case 'ArrowRight':
      return direction === 'ltr' ? 'next' : 'prev';
    case 'ArrowLeft':
      return direction === 'ltr' ? 'prev' : 'next';
    default:
      return null;
  }
}

/** A spread inside the book: 0..ceil(n / 2) with a document, only 0 without one. Fractions round. */
export function clampSpread(spread: number, pageCount: number, hasDocument: boolean): number {
  if (!hasDocument || Number.isNaN(spread)) return 0;
  return Math.min(Math.max(Math.round(spread), 0), maxSpread(pageCount));
}

/*
 * Exact frames (no negative scale anywhere). The spine (hinge) axis is at book-local x = 0 and runs along the
 * page height. A leaf is built in its hinge frame, with s the distance from the spine; unturned leaves extend
 * towards `outward` (+x for LTR: the closed LTR book has its binding on the left) and a turn rotates the leaf
 * by an angle in [0, pi] about the spine axis with sign `turnSign`, ending on the opposite side.
 * Each face's UVs make its texture read correctly seen from that face: the front face's u runs from the
 * screen-left to the screen-right in the unturned pose (from the spine for LTR, towards the spine for RTL);
 * the back face uses u' = 1 - u. Textures are never mirrored.
 */
export interface LeafFrame {
  hingeSide: Side;
  /** +1: unturned leaves extend towards +x; -1: towards -x. */
  outward: 1 | -1;
  /** Sign of the rotation about the spine axis. */
  turnSign: 1 | -1;
  /** Front-face u grows with the distance from the spine (LTR) or shrinks with it (RTL). */
  frontUFromSpine: boolean;
  /** The back face samples its texture at u' = 1 - u. */
  backUvFlip: true;
}

const LTR_FRAME: LeafFrame = Object.freeze({
  hingeSide: 'left',
  outward: 1,
  turnSign: 1,
  frontUFromSpine: true,
  backUvFlip: true,
});
const RTL_FRAME: LeafFrame = Object.freeze({
  hingeSide: 'right',
  outward: -1,
  turnSign: -1,
  frontUFromSpine: false,
  backUvFlip: true,
});

/** The frame of a layout direction: a shared immutable constant, so asking for it every frame allocates nothing. */
export function leafFrame(direction: Direction): LeafFrame {
  return direction === 'ltr' ? LTR_FRAME : RTL_FRAME;
}

export interface CoverFrame {
  hingeSide: Side;
  outward: 1 | -1;
  turnSign: 1 | -1;
  /**
   * The cover art and the spine bands are invariant under a half turn about the table normal, so swapping
   * the layout direction of a closed book (a yaw of pi) is invisible.
   */
  c2Symmetric: true;
}

function coverFrameOf(direction: Direction): CoverFrame {
  const { hingeSide, outward, turnSign } = leafFrame(direction);
  return Object.freeze({ hingeSide, outward, turnSign, c2Symmetric: true });
}
const LTR_COVER = coverFrameOf('ltr');
const RTL_COVER = coverFrameOf('rtl');

export function coverFrame(direction: Direction): CoverFrame {
  return direction === 'ltr' ? LTR_COVER : RTL_COVER;
}

/** One page in view on a narrow screen. */
export interface NarrowPosition {
  spread: number;
  /** null means "the first page of the spread". */
  focusSide: Side | null;
}

/**
 * Single-page navigation for narrow screens. LTR: left, right, then the next spread's left; RTL: right,
 * left, then the next spread's right. The bookplate spread has one page. It never walks onto a blank face.
 */
export function navigateNarrow(
  position: NarrowPosition,
  action: 'next' | 'prev',
  direction: Direction,
  pageCount: number,
): { spread: number; focusSide: Side } {
  const turned = turnedSide(direction);
  const unturned = unturnedSide(direction);
  const top = maxSpread(pageCount);
  const { spread } = position;
  const side: Side = position.focusSide ?? (spread <= 0 ? unturned : turned);
  const stay = { spread, focusSide: side };
  const exists = (target: number, targetSide: Side): boolean => {
    if (target < 0 || target > top) return false;
    if (target === 0) return targetSide === unturned;
    const faces = facesOnSpread(target, pageCount, direction, true);
    return (targetSide === 'left' ? faces.left : faces.right) !== 'blank';
  };

  if (action === 'next') {
    if (spread >= 1 && side === turned)
      return exists(spread, unturned) ? { spread, focusSide: unturned } : stay;
    return exists(spread + 1, turned) ? { spread: spread + 1, focusSide: turned } : stay;
  }
  if (spread >= 1 && side === unturned) return { spread, focusSide: turned };
  if (spread >= 2) return { spread: spread - 1, focusSide: unturned };
  if (spread === 1) return { spread: 0, focusSide: unturned };
  return stay;
}
