import { PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import {
  STAGE_FOOTER_PX,
  STAGE_FOOTER_PX_NARROW,
  WRITING_ELEVATION_DEG,
  applyPose,
  computeAnchors,
  framingFootprint,
  framingFor,
  framingKindFor,
  reservationFor,
  type FramingContext,
} from '../../src/scene/cameraFraming';
import { PAGE_H, PAGE_W } from '../../src/scene/book/dimensions';

/*
 * The writing framing (global section T): the book is turned to a diary page and the camera dives onto it, so that the page
 * faces the viewer and fills most of the view. It is the "Read closely" framing of the diary page, a little less full (the
 * writing surface needs air around it) and steeper.
 */

const SIZES = [
  [1280, 720],
  [1440, 900],
  [1920, 1080],
  [2560, 1440],
] as const;

function writingContext(
  width: number,
  height: number,
  direction: 'ltr' | 'rtl',
  phase: 'awaiting' | 'manuscript' = 'manuscript',
): FramingContext {
  return {
    phase,
    width,
    height,
    direction,
    leafCount: 12,
    focusSide: direction === 'ltr' ? 'right' : 'left',
    writing: true,
  };
}

/** Where the corners of the page footprint land on the screen (pixels, origin top left). */
function pagePixels(context: FramingContext) {
  const pose = framingFor(context);
  const camera = new PerspectiveCamera(pose.fov, context.width / context.height, 0.05, 60);
  applyPose(camera, pose);
  const { footprint, center } = framingFootprint(framingKindFor(context.phase, true), context);
  const corners = [-1, 1].flatMap((sx) =>
    [-1, 1].map((sz) => {
      const point = camera.position
        .clone()
        .set(center.x + (sx * footprint.width) / 2, 0.02, center.z + (sz * footprint.depth) / 2);
      point.project(camera);
      return { x: ((point.x + 1) / 2) * context.width, y: ((1 - point.y) / 2) * context.height };
    }),
  );
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

describe('the framing kind of writing', () => {
  it('is a reading framing in the awaiting and manuscript phases, whatever it was; other phases are untouched', () => {
    expect(framingKindFor('awaiting')).toBe('open');
    expect(framingKindFor('awaiting', true)).toBe('reading');
    expect(framingKindFor('manuscript', true)).toBe('reading');
    expect(framingKindFor('discovery', true)).toBe('open'); // the welcome book lies open
    expect(framingKindFor('closing', true)).toBe('closed');
    expect(framingKindFor('uploading', true)).toBe('open');
  });
});

describe('the writing pose', () => {
  it.each(['ltr', 'rtl'] as const)(
    '%s: the page fills about 85% of the view height, clear of the footer, on every screen',
    (direction) => {
      for (const [width, height] of SIZES) {
        for (const phase of ['manuscript', 'awaiting'] as const) {
          const box = pagePixels(writingContext(width, height, direction, phase));
          const fraction = (box.bottom - box.top) / height;
          expect(fraction, `${String(width)}x${String(height)} ${phase}`).toBeGreaterThan(0.78);
          expect(fraction, `${String(width)}x${String(height)} ${phase}`).toBeLessThan(0.9);
          expect(box.bottom, `${String(width)}x${String(height)}`).toBeLessThanOrEqual(
            height - STAGE_FOOTER_PX + 1,
          );
          expect(box.top).toBeGreaterThanOrEqual(0);
        }
      }
    },
  );

  it('centres the page in the view, on either side of the book', () => {
    for (const direction of ['ltr', 'rtl'] as const) {
      const box = pagePixels(writingContext(1440, 900, direction));
      expect((box.left + box.right) / 2).toBeGreaterThan(1440 / 2 - 20);
      expect((box.left + box.right) / 2).toBeLessThan(1440 / 2 + 20);
    }
  });

  it('looks steeply down, so the page faces the viewer', () => {
    expect(WRITING_ELEVATION_DEG).toBeGreaterThanOrEqual(78);
    const pose = framingFor(writingContext(1440, 900, 'ltr'));
    const dy = pose.position.y - pose.target.y;
    const run = Math.hypot(pose.position.x - pose.target.x, pose.position.z - pose.target.z);
    expect((Math.atan2(dy, run) * 180) / Math.PI).toBeCloseTo(WRITING_ELEVATION_DEG, 0);
  });

  it('is a different pose from reading closely, and from the plain reading pose', () => {
    const base = { ...writingContext(1440, 900, 'ltr'), writing: false };
    expect(framingFor(writingContext(1440, 900, 'ltr'))).not.toEqual(framingFor(base));
    expect(framingFor(writingContext(1440, 900, 'ltr'))).not.toEqual(framingFor({ ...base, closely: true }));
  });

  it('on a phone the page fits the width, and sits above the keyboard', () => {
    const keyboard = 300;
    const context: FramingContext = { ...writingContext(390, 844, 'ltr'), bottomInsetPx: keyboard };
    const box = pagePixels(context);
    expect(box.right - box.left).toBeLessThanOrEqual(390 + 1);
    expect(box.right - box.left).toBeGreaterThan(390 * 0.8);
    expect(box.bottom).toBeLessThanOrEqual(844 - keyboard + 1);
    expect(box.top).toBeGreaterThanOrEqual(0);
  });

  it('without a keyboard the phone keeps clear of the stacked footer', () => {
    const box = pagePixels(writingContext(390, 844, 'rtl'));
    expect(box.bottom).toBeLessThanOrEqual(844 - STAGE_FOOTER_PX_NARROW + 1);
  });
});

describe('the room kept for the writing', () => {
  it('there is no panel any more: the manuscript is framed centred, on a wide screen and on a phone', () => {
    expect(reservationFor('manuscript', 1440, 900, 'ltr')).toEqual({
      left: 0,
      right: 0,
      bottom: STAGE_FOOTER_PX / 900,
    });
    expect(reservationFor('memory', 1440, 900, 'rtl')).toEqual({
      left: 0,
      right: 0,
      bottom: STAGE_FOOTER_PX / 900,
    });
    expect(reservationFor('manuscript', 390, 844, 'ltr').bottom).toBeCloseTo(STAGE_FOOTER_PX_NARROW / 844, 9);
  });

  it('writing keeps the footer clear in the awaiting phase too, and a keyboard takes more from the bottom', () => {
    expect(reservationFor('awaiting', 1440, 900, 'ltr')).toEqual({ left: 0, right: 0, bottom: 0 });
    expect(reservationFor('awaiting', 1440, 900, 'ltr', { writing: true }).bottom).toBeCloseTo(
      STAGE_FOOTER_PX / 900,
      9,
    );
    expect(
      reservationFor('manuscript', 390, 844, 'ltr', { writing: true, bottomPx: 300 }).bottom,
    ).toBeCloseTo(300 / 844, 9);
    // a small keyboard inset never takes less than the footer
    expect(reservationFor('manuscript', 390, 844, 'ltr', { writing: true, bottomPx: 10 }).bottom).toBeCloseTo(
      STAGE_FOOTER_PX_NARROW / 844,
      9,
    );
  });
});

describe('the corners of the pages on the screen (what the writing surface is mapped onto)', () => {
  const ctx = writingContext(1440, 900, 'ltr');
  const pose = framingFor(ctx);
  const anchors = computeAnchors(
    pose,
    { width: 1440, height: 900 },
    { open: true, spread: 0, direction: 'ltr', leafCount: 12 },
  );

  it('are four points in the order top-left, top-right, bottom-right, bottom-left, inside the bounding rectangle', () => {
    for (const side of ['leftPage', 'rightPage'] as const) {
      const quad = anchors.quads[side];
      const rect = anchors[side];
      expect(quad).not.toBeNull();
      expect(rect).not.toBeNull();
      if (!quad || !rect) continue;
      const [tl, tr, br, bl] = quad;
      expect(tl.x).toBeLessThan(tr.x);
      expect(bl.x).toBeLessThan(br.x);
      expect(tl.y).toBeLessThan(bl.y);
      expect(tr.y).toBeLessThan(br.y);
      for (const point of quad) {
        expect(point.x).toBeGreaterThanOrEqual(rect.x - 1e-6);
        expect(point.x).toBeLessThanOrEqual(rect.x + rect.width + 1e-6);
        expect(point.y).toBeGreaterThanOrEqual(rect.y - 1e-6);
        expect(point.y).toBeLessThanOrEqual(rect.y + rect.height + 1e-6);
      }
    }
  });

  it('a closed book has none', () => {
    const closed = computeAnchors(
      framingFor({ ...ctx, phase: 'discovery', writing: false }),
      { width: 1440, height: 900 },
      { open: false, spread: 0, direction: 'ltr', leafCount: 12 },
    );
    expect(closed.quads.leftPage).toBeNull();
    expect(closed.quads.rightPage).toBeNull();
  });

  it('the page is the page: its quad keeps the proportions of the page (a little foreshortened from above)', () => {
    const quad = anchors.quads.rightPage;
    if (!quad) throw new Error('no quad');
    const width = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y);
    const height = Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y);
    expect(height / width).toBeGreaterThan((PAGE_H / PAGE_W) * 0.85);
    expect(height / width).toBeLessThan((PAGE_H / PAGE_W) * 1.05);
  });
});

describe('the writing view faces the page squarely', () => {
  it('the lines of the page run parallel to the top of the screen: the mapped baseline is not turned (every size, both directions)', async () => {
    const { computeAnchors } = await import('../../src/scene/cameraFraming');
    const { baselineAngle, homography, rectQuad } = await import('../../src/ui/diary/homography');
    for (const [width, height] of SIZES.concat([[390, 844]] as never)) {
      for (const direction of ['ltr', 'rtl'] as const) {
        const context = writingContext(width, height, direction);
        const pose = framingFor(context);
        const anchors = computeAnchors(
          pose,
          { width, height },
          { open: true, spread: 0, direction, leafCount: 12 },
        );
        const quad = direction === 'ltr' ? anchors.quads.rightPage : anchors.quads.leftPage;
        expect(quad).not.toBeNull();
        if (!quad) continue;
        const map = homography(rectQuad(520, 728), quad);
        expect(map).not.toBeNull();
        if (map) expect(Math.abs(baselineAngle(map, 520, 728))).toBeLessThan(0.5);
      }
    }
  });
});
