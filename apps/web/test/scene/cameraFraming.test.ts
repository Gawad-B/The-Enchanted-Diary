import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { Phase } from '../../src/state/experience';
import {
  PAGE_H,
  PAGE_W,
  openFootprint,
  turnedLeafY,
  unturnedLeafY,
  virtualLeafTotal,
} from '../../src/scene/book/dimensions';
import { hingeOffset, leafPoint } from '../../src/scene/book/leafReach';
import {
  applyPose,
  computeAnchors,
  fitBookToViewport,
  framingFor,
  framingFootprint,
  framingKindFor,
  isNarrow,
  isReadingPhase,
  maxMotionForPixels,
  motionAmplitude,
  poseDistance,
  reservationFor,
  READING_MOTION_CAP_PX,
  STAGE_FOOTER_PX,
  STAGE_FOOTER_PX_NARROW,
  type Footprint,
  type Reserved,
} from '../../src/scene/cameraFraming';

const ASPECTS = [0.45, 0.46, 0.6, 0.75, 1, 1.3, 1.6, 1.78, 2.1, 2.4];
const PHASES: Phase[] = [
  'discovery',
  'opening',
  'awaiting',
  'uploading',
  'reading',
  'unveiling',
  'manuscript',
  'revealing',
  'memory',
  'closing',
];

/** NDC box of the footprint's eight corners seen from `camera`. */
function ndcBox(camera: PerspectiveCamera, footprint: Footprint, center = { x: 0, z: 0 }) {
  const corner = new Vector3();
  const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (let i = 0; i < 8; i += 1) {
    corner
      .set(
        center.x + ((i & 1) === 0 ? -1 : 1) * (footprint.width / 2),
        (i & 2) === 0 ? 0 : footprint.height,
        center.z + ((i & 4) === 0 ? -1 : 1) * (footprint.depth / 2),
      )
      .project(camera);
    box.minX = Math.min(box.minX, corner.x);
    box.maxX = Math.max(box.maxX, corner.x);
    box.minY = Math.min(box.minY, corner.y);
    box.maxY = Math.max(box.maxY, corner.y);
  }
  return box;
}

function cameraFor(
  aspect: number,
  elevationDeg: number,
  fit: ReturnType<typeof fitBookToViewport>,
  fov = 38,
) {
  const camera = new PerspectiveCamera(fov, aspect, 0.05, 60);
  const e = (elevationDeg * Math.PI) / 180;
  applyPose(camera, {
    fov,
    target: fit.target,
    position: {
      x: fit.target.x,
      y: fit.distance * Math.sin(e),
      z: fit.target.z + fit.distance * Math.cos(e),
    },
  });
  return camera;
}

describe('fitBookToViewport', () => {
  const footprint: Footprint = { width: 3.1, depth: 2.24, height: 0.35 };

  it('the whole book is visible for every aspect ratio from 0.45 to 2.4', () => {
    for (const aspect of ASPECTS) {
      const fit = fitBookToViewport(aspect, undefined, { footprint, fill: 0.9, elevationDeg: 55 });
      const box = ndcBox(cameraFor(aspect, 55, fit), footprint);
      expect(box.minX, `aspect ${aspect}`).toBeGreaterThanOrEqual(-1);
      expect(box.maxX, `aspect ${aspect}`).toBeLessThanOrEqual(1);
      expect(box.minY, `aspect ${aspect}`).toBeGreaterThanOrEqual(-1);
      expect(box.maxY, `aspect ${aspect}`).toBeLessThanOrEqual(1);
    }
  });

  it('is the nearest distance that fits: the book touches the limit of the free region', () => {
    for (const aspect of [0.6, 1.78]) {
      const fit = fitBookToViewport(aspect, undefined, { footprint, fill: 0.8, elevationDeg: 55 });
      const box = ndcBox(cameraFor(aspect, 55, fit), footprint);
      const widthFill = (box.maxX - box.minX) / 2;
      const heightFill = (box.maxY - box.minY) / 2;
      expect(Math.max(widthFill, heightFill)).toBeGreaterThan(0.79);
      expect(Math.max(widthFill, heightFill)).toBeLessThanOrEqual(0.8 + 1e-3);
    }
  });

  it('centres the book in the viewport when nothing is reserved', () => {
    const fit = fitBookToViewport(1.6, undefined, { footprint, fill: 0.8, elevationDeg: 55 });
    const box = ndcBox(cameraFor(1.6, 55, fit), footprint);
    expect((box.minX + box.maxX) / 2).toBeCloseTo(0, 2);
    expect((box.minY + box.maxY) / 2).toBeCloseTo(0, 2);
  });

  it('a reservation on the right keeps the book in the left part of the screen', () => {
    for (const aspect of [1, 1.6, 2.4]) {
      const reserved: Reserved = { left: 0, right: 0.32, bottom: 0 };
      const fit = fitBookToViewport(aspect, reserved, { footprint, fill: 0.94, elevationDeg: 67 });
      const box = ndcBox(cameraFor(aspect, 67, fit), footprint);
      // Right 32% of the width is NDC x > 1 - 0.64 = 0.36.
      expect(box.maxX, `aspect ${aspect}`).toBeLessThanOrEqual(0.36 + 1e-3);
      expect(box.minX).toBeGreaterThanOrEqual(-1);
    }
  });

  it('a reservation on the left keeps the book in the right part of the screen (the mirror image)', () => {
    for (const aspect of [1, 1.6, 2.4]) {
      const reserved: Reserved = { left: 0.32, right: 0, bottom: 0 };
      const fit = fitBookToViewport(aspect, reserved, { footprint, fill: 0.94, elevationDeg: 67 });
      const box = ndcBox(cameraFor(aspect, 67, fit), footprint);
      expect(box.minX, `aspect ${aspect}`).toBeGreaterThanOrEqual(-0.36 - 1e-3);
      expect(box.maxX).toBeLessThanOrEqual(1);
    }
  });

  it('the two reservations are exact mirror images', () => {
    const right = fitBookToViewport(
      1.6,
      { left: 0, right: 0.32, bottom: 0 },
      { footprint, fill: 0.9, elevationDeg: 60 },
    );
    const left = fitBookToViewport(
      1.6,
      { left: 0.32, right: 0, bottom: 0 },
      { footprint, fill: 0.9, elevationDeg: 60 },
    );
    expect(left.distance).toBeCloseTo(right.distance, 3);
    expect(left.target.x).toBeCloseTo(-right.target.x, 3);
  });

  it('a bottom reservation (the sheet peek on a phone) keeps the book above it', () => {
    const reserved: Reserved = { left: 0, right: 0, bottom: 0.2 };
    const fit = fitBookToViewport(0.46, reserved, {
      footprint: { width: 1.6, depth: 2.26, height: 0.3 },
      fill: 0.96,
      elevationDeg: 72,
    });
    const box = ndcBox(cameraFor(0.46, 72, fit), { width: 1.6, depth: 2.26, height: 0.3 });
    expect(box.minY).toBeGreaterThanOrEqual(-1 + 0.4 - 1e-3);
    expect(box.maxY).toBeLessThanOrEqual(1);
  });

  it('a more generous reservation never brings the camera closer', () => {
    const none = fitBookToViewport(1.6, undefined, { footprint, fill: 0.9, elevationDeg: 60 });
    const some = fitBookToViewport(
      1.6,
      { left: 0, right: 0.32, bottom: 0 },
      { footprint, fill: 0.9, elevationDeg: 60 },
    );
    expect(some.distance).toBeGreaterThanOrEqual(none.distance - 1e-6);
  });
});

describe('framing per phase', () => {
  it('reading and closing frame the closed book; discovery (the welcome: the book lies open and leafs), opening and awaiting the open one; the rest read', () => {
    expect(['closing'].map((p) => framingKindFor(p as Phase))).toEqual(['closed']);
    expect(
      ['discovery', 'reading', 'opening', 'awaiting', 'uploading'].map((p) => framingKindFor(p as Phase)),
    ).toEqual(['open', 'open', 'open', 'open', 'open']);
    expect(['unveiling', 'manuscript', 'revealing', 'memory'].map((p) => framingKindFor(p as Phase))).toEqual(
      ['reading', 'reading', 'reading', 'reading'],
    );
  });

  it('every phase keeps its book fully visible from phone to ultra-wide, in both directions', () => {
    for (const phase of PHASES) {
      for (const [width, height] of [
        [390, 844],
        [768, 1024],
        [1440, 900],
        [1920, 1080],
        [3440, 1440],
        [900, 2000],
      ] as const) {
        for (const direction of ['ltr', 'rtl'] as const) {
          const context = { phase, width, height, direction, leafCount: 12, focusSide: null };
          const pose = framingFor(context);
          const camera = new PerspectiveCamera(pose.fov, width / height, 0.05, 60);
          applyPose(camera, pose);
          const kind = framingKindFor(phase);
          const { footprint, center } = framingFootprint(kind, context);
          const box = ndcBox(camera, footprint, center);
          const label = `${phase} ${width}x${height} ${direction}`;
          expect(box.minX, label).toBeGreaterThanOrEqual(-1);
          expect(box.maxX, label).toBeLessThanOrEqual(1);
          expect(box.minY, label).toBeGreaterThanOrEqual(-1);
          expect(box.maxY, label).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('the closed book fills about 60% of the short side on a wide screen', () => {
    const context = {
      phase: 'reading' as const,
      width: 1440,
      height: 900,
      direction: 'ltr' as const,
      leafCount: 12,
      focusSide: null,
    };
    const pose = framingFor(context);
    const camera = new PerspectiveCamera(pose.fov, 1440 / 900, 0.05, 60);
    applyPose(camera, pose);
    const { footprint } = framingFootprint('closed', context);
    const box = ndcBox(camera, footprint);
    const heightFraction = (box.maxY - box.minY) / 2;
    const widthPixels = ((box.maxX - box.minX) / 2) * 1440;
    expect(heightFraction).toBeGreaterThan(0.5);
    expect(heightFraction).toBeLessThanOrEqual(0.6 + 1e-3);
    expect(widthPixels).toBeLessThan(1440 * 0.6);
  });

  it("the manuscript is framed centred on a wide screen: the diary has no panel beside the book (it is written on the book's own pages)", () => {
    for (const direction of ['ltr', 'rtl'] as const) {
      const context = {
        phase: 'manuscript' as const,
        width: 1440,
        height: 900,
        direction,
        leafCount: 12,
        focusSide: null,
      };
      expect(reservationFor('manuscript', 1440, 900, direction)).toEqual({
        left: 0,
        right: 0,
        bottom: STAGE_FOOTER_PX / 900,
      });
      const pose = framingFor(context);
      const camera = new PerspectiveCamera(pose.fov, 1440 / 900, 0.05, 60);
      applyPose(camera, pose);
      const box = ndcBox(camera, framingFootprint('reading', context).footprint);
      expect((box.minX + box.maxX) / 2).toBeCloseTo(0, 1);
    }
  });

  it('every reading framing keeps the footer clear and nothing else is reserved, on any width', () => {
    for (const phase of PHASES) {
      const reading = framingKindFor(phase) === 'reading';
      const footer = reading ? STAGE_FOOTER_PX / 900 : 0;
      const reserved = reservationFor(phase, 1440, 900, 'ltr');
      expect(reserved.bottom, phase).toBeCloseTo(footer, 9);
      expect(reserved.left + reserved.right, phase).toBe(0);
    }
    expect(reservationFor('manuscript', 1099, 800, 'ltr')).toEqual({
      left: 0,
      right: 0,
      bottom: STAGE_FOOTER_PX / 800,
    });
    // A phone's footer wraps to two lines: the stacked footer's height is what is kept.
    expect(reservationFor('manuscript', 390, 844, 'ltr').bottom).toBeCloseTo(STAGE_FOOTER_PX_NARROW / 844, 5);
    expect(reservationFor('revealing', 390, 844, 'ltr').bottom).toBeCloseTo(STAGE_FOOTER_PX_NARROW / 844, 5);
    expect(reservationFor('discovery', 1440, 900, 'ltr')).toEqual({ left: 0, right: 0, bottom: 0 });
    expect(reservationFor('awaiting', 1440, 900, 'ltr')).toEqual({ left: 0, right: 0, bottom: 0 });
  });

  it("the open book keeps clear of the footer in the reading framings: its near edge ends a footer's height above the bottom, 16:9 included, thick books too", () => {
    for (const [width, height] of [
      [1920, 1080],
      [1280, 720],
      [1440, 900],
      [2560, 1440],
      [1366, 768],
      [1100, 700],
    ] as const) {
      for (const leafCount of [21, 150]) {
        const pose = framingFor({
          phase: 'manuscript',
          width,
          height,
          direction: 'ltr',
          leafCount,
          focusSide: null,
        });
        const camera = new PerspectiveCamera(pose.fov, width / height, 0.05, 60);
        applyPose(camera, pose);
        const footprint = openFootprint();
        let lowest = -Infinity;
        for (const x of [-footprint.width / 2, footprint.width / 2]) {
          const v = new Vector3(x, 0, footprint.depth / 2).project(camera);
          lowest = Math.max(lowest, ((1 - v.y) / 2) * height);
        }
        expect(
          height - lowest,
          `${String(width)}x${String(height)} ${String(leafCount)} leaves`,
        ).toBeGreaterThanOrEqual(STAGE_FOOTER_PX - 2);
      }
    }
  });

  it('on a narrow screen the reading framing is one page, centred on the focused side', () => {
    const base = {
      phase: 'manuscript' as const,
      width: 390,
      height: 844,
      direction: 'ltr' as const,
      leafCount: 12,
    };
    const left = framingFor({ ...base, focusSide: 'left' });
    const right = framingFor({ ...base, focusSide: 'right' });
    expect(left.target.x).toBeLessThan(right.target.x);
    expect(framingFootprint('reading', { ...base, focusSide: 'left' }).footprint.width).toBeLessThan(2);
    // The page fills most of the width on a phone.
    const camera = new PerspectiveCamera(left.fov, 390 / 844, 0.05, 60);
    applyPose(camera, left);
    const { footprint, center } = framingFootprint('reading', { ...base, focusSide: 'left' });
    const box = ndcBox(camera, footprint, center);
    expect(box.maxX - box.minX).toBeGreaterThan(1.5);
  });

  it('on a narrow screen awaiting and uploading frame the flyleaf as one readable page, either direction', () => {
    for (const direction of ['ltr', 'rtl'] as const) {
      for (const phase of ['awaiting', 'uploading'] as const) {
        // `focusSide: null` and a stale side from an earlier reading must not matter: the flyleaf is on the
        // unturned side of spread 0.
        for (const focusSide of [null, 'left', 'right'] as const) {
          const context = { phase, width: 390, height: 844, direction, leafCount: 12, focusSide };
          const pose = framingFor(context);
          const anchors = computeAnchors(
            pose,
            { width: 390, height: 844 },
            { open: true, spread: 0, direction, leafCount: 12 },
          );
          const label = `${phase} ${direction} ${String(focusSide)}`;
          const flyleaf = anchors.flyleaf;
          expect(flyleaf, label).not.toBeNull();
          if (!flyleaf) continue;
          expect(flyleaf.width, label).toBeGreaterThan(390 * 0.8);
          expect(flyleaf.x, label).toBeGreaterThanOrEqual(-1);
          expect(flyleaf.x + flyleaf.width, label).toBeLessThanOrEqual(391);
        }
      }
    }
  });

  it('opening still shows the whole book on a phone, and wide screens keep the whole spread in awaiting', () => {
    const opening = framingFor({
      phase: 'opening',
      width: 390,
      height: 844,
      direction: 'ltr',
      leafCount: 12,
      focusSide: null,
    });
    const anchors = computeAnchors(
      opening,
      { width: 390, height: 844 },
      { open: true, spread: 0, direction: 'ltr', leafCount: 12 },
    );
    expect(anchors.leftPage?.x).toBeGreaterThanOrEqual(0);
    expect((anchors.rightPage?.x ?? 0) + (anchors.rightPage?.width ?? 0)).toBeLessThanOrEqual(390);
    const wide = framingFor({
      phase: 'awaiting',
      width: 1440,
      height: 900,
      direction: 'ltr',
      leafCount: 12,
      focusSide: null,
    });
    const wideAnchors = computeAnchors(
      wide,
      { width: 1440, height: 900 },
      { open: true, spread: 0, direction: 'ltr', leafCount: 12 },
    );
    expect(wideAnchors.flyleaf?.width).toBeLessThan(1440 * 0.5);
  });

  it('narrow means under 720 px', () => {
    expect(isNarrow(719)).toBe(true);
    expect(isNarrow(720)).toBe(false);
  });

  it('a phone looks flatter than a laptop at the same kind of framing is not required, but never lower than the laptop elevation', () => {
    const phone = framingFor({
      phase: 'discovery',
      width: 390,
      height: 844,
      direction: 'ltr',
      leafCount: 12,
      focusSide: null,
    });
    expect(phone.position.y).toBeGreaterThan(0);
  });
});

describe('the reading framing keeps a turning leaf in the picture', () => {
  /**
   * The free edge of the leaves of a book, where the rig and the shader put them (the TypeScript port of both): every
   * `step`th leaf, every angle in hundredths of a turn, forward and back, head, middle and tail, on both sides of the
   * gutter. The thick end of a book is the dangerous one: the hinge rides at mid-block height, and a leaf turned back is
   * carried past the vertical by its bend.
   */
  function leafEdgePoints(leafCount: number, thetaStep = 0.01): Vector3[] {
    const total = virtualLeafTotal(leafCount);
    const points: Vector3[] = [];
    const hinge = { x: 0, y: 0 };
    const tip = { x: 0, y: 0 };
    const leaves = new Set<number>([
      0,
      1,
      leafCount - 1,
      Math.floor(leafCount / 2),
      Math.floor(leafCount * 0.37),
    ]);
    for (let leaf = 0; leaf < leafCount; leaf += Math.max(1, Math.floor(leafCount / 10))) leaves.add(leaf);
    for (const leaf of leaves) {
      if (leaf < 0 || leaf >= leafCount) continue;
      for (let theta = 0; theta <= 1 + 1e-9; theta += thetaStep) {
        hingeOffset(unturnedLeafY(leaf, total), turnedLeafY(leaf), theta, 1, hinge);
        for (const turnV of [1, -1]) {
          for (const z of [-PAGE_H / 2, 0, PAGE_H / 2]) {
            leafPoint(PAGE_W, z, theta, turnV, tip);
            for (const side of [1, -1])
              points.push(new Vector3(side * (hinge.x + tip.x), hinge.y + tip.y, z));
          }
        }
      }
    }
    return points;
  }

  it("the leaves' real reach is inside the picture at every common screen size, in both directions, for a book of 2 to 300 pages", () => {
    for (const [width, height] of [
      [1920, 1080],
      [2560, 1440],
      [3840, 2160],
      [1440, 900],
      [1100, 700],
      [1280, 720],
      [1024, 768],
      [768, 1024],
      [3440, 1440],
      [390, 844],
      [360, 640],
    ] as const) {
      for (const direction of ['ltr', 'rtl'] as const) {
        for (const leafCount of [1, 21, 100, 150]) {
          const pose = framingFor({
            phase: 'manuscript',
            width,
            height,
            direction,
            leafCount,
            focusSide: direction === 'ltr' ? 'right' : 'left',
          });
          const camera = new PerspectiveCamera(pose.fov, width / height, 0.05, 60);
          applyPose(camera, pose);
          const extent = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
          const v = new Vector3();
          for (const point of leafEdgePoints(leafCount)) {
            v.copy(point).project(camera);
            extent.minX = Math.min(extent.minX, v.x);
            extent.maxX = Math.max(extent.maxX, v.x);
            extent.minY = Math.min(extent.minY, v.y);
            extent.maxY = Math.max(extent.maxY, v.y);
          }
          const label = `${String(width)}x${String(height)} ${direction} ${String(leafCount)} leaves`;
          expect(extent.maxY, `${label}: the highest point of any leaf`).toBeLessThan(1);
          expect(extent.minY, `${label}: the lowest`).toBeGreaterThan(-1);
          // On a phone the gutter is the edge of the page that fills the width: the curl leans out of the picture there.
          if (width >= 768) {
            expect(extent.minX, `${label}: the leftmost`).toBeGreaterThan(-1);
            expect(extent.maxX, `${label}: the rightmost`).toBeLessThan(1);
          }
        }
      }
    }
  });

  it('memory frames it like manuscript (both are reading framings)', () => {
    for (const phase of ['memory', 'unveiling', 'revealing'] as const) {
      const pose = framingFor({
        phase,
        width: 1920,
        height: 1080,
        direction: 'ltr',
        leafCount: 150,
        focusSide: null,
      });
      const camera = new PerspectiveCamera(pose.fov, 1920 / 1080, 0.05, 60);
      applyPose(camera, pose);
      for (const point of leafEdgePoints(150, 0.05)) {
        expect(point.clone().project(camera).y, phase).toBeLessThan(1);
      }
    }
  });

  it("without the diary's panel the pages are framed at least as large as they were beside it (the height and the leaf's reach now decide the size)", () => {
    // Beside the panel the book had 68% of the width; now it has all of it, so the camera is never farther away than it was.
    for (const [width, height] of [
      [1440, 900],
      [1920, 1080],
      [1280, 720],
    ] as const) {
      const context = {
        phase: 'manuscript' as const,
        width,
        height,
        direction: 'ltr' as const,
        leafCount: 21,
        focusSide: null,
      };
      const pose = framingFor(context);
      const distance = Math.hypot(
        pose.position.x - pose.target.x,
        pose.position.y - pose.target.y,
        pose.position.z - pose.target.z,
      );
      const { footprint, center } = framingFootprint('reading', context);
      const beside = fitBookToViewport(
        width / height,
        { left: 0, right: 0.32, bottom: STAGE_FOOTER_PX / height },
        { elevationDeg: 67, footprint, fill: 0.94, center },
      );
      expect(distance, `${String(width)}x${String(height)}`).toBeLessThanOrEqual(beside.distance + 1e-6);
    }
  });
});

describe('motion caps', () => {
  it('maxMotionForPixels converts pixels to scene units at the camera distance', () => {
    // At distance 5 with a 38 degree fov the view is 2 * 5 * tan(19) = 3.44 units tall.
    const units = maxMotionForPixels(2, 5, 38, 900);
    const pixelsPerUnit = 900 / (2 * 5 * Math.tan((19 * Math.PI) / 180));
    expect(units * pixelsPerUnit).toBeCloseTo(2, 5);
  });

  it('in the reading phases drift plus parallax move the page by at most 2 px', () => {
    for (const phase of ['opening', 'awaiting', 'uploading', 'manuscript', 'revealing', 'memory'] as const) {
      for (const [distance, height] of [
        [4, 900],
        [6, 1080],
        [3, 400],
      ] as const) {
        const { parallax, drift } = motionAmplitude(phase, false, distance, 38, height);
        const pixelsPerUnit = height / (2 * distance * Math.tan((38 * Math.PI) / 360));
        expect((parallax + drift) * pixelsPerUnit, `${phase} ${distance}`).toBeLessThanOrEqual(
          READING_MOTION_CAP_PX + 1e-6,
        );
      }
    }
  });

  it('the closed book (reading) keeps the full parallax and drift, and reduced motion removes both everywhere', () => {
    expect(motionAmplitude('reading', false, 6, 38, 900).parallax).toBeGreaterThan(0.05);
    for (const phase of ['discovery', 'manuscript', 'opening'] as const) {
      expect(motionAmplitude(phase, true, 6, 38, 900)).toEqual({ parallax: 0, drift: 0 });
    }
  });

  it('knows which phases are reading phases', () => {
    expect(isReadingPhase('manuscript')).toBe(true);
    expect(isReadingPhase('awaiting')).toBe(true);
    // The camera is held for the open book from the start of the opening (no lean that would jump at awaiting).
    expect(isReadingPhase('opening')).toBe(true);
    expect(isReadingPhase('discovery')).toBe(true); // the welcome: an open book that leafs
    expect(isReadingPhase('reading')).toBe(false);
  });
});

describe('allocation-free helpers and the rest pose', () => {
  it('motionAmplitude writes into the object it is given and returns it', () => {
    const out = { parallax: -1, drift: -1 };
    const result = motionAmplitude('manuscript', false, 6, 38, 900, out);
    expect(result).toBe(out);
    const fresh = motionAmplitude('manuscript', false, 6, 38, 900);
    expect(out).toEqual(fresh);
    expect(motionAmplitude('discovery', true, 6, 38, 900, out)).toBe(out);
    expect(out).toEqual({ parallax: 0, drift: 0 });
  });

  it('poseDistance is zero for the same pose and grows with the camera or the target moving', () => {
    const pose = framingFor({
      phase: 'manuscript',
      width: 1440,
      height: 900,
      direction: 'ltr',
      leafCount: 12,
      focusSide: null,
    });
    expect(poseDistance(pose, pose)).toBe(0);
    expect(
      poseDistance(pose, { ...pose, position: { ...pose.position, y: pose.position.y + 0.5 } }),
    ).toBeCloseTo(0.5);
    expect(poseDistance(pose, { ...pose, target: { ...pose.target, x: pose.target.x - 0.25 } })).toBeCloseTo(
      0.25,
    );
    const other = framingFor({
      phase: 'discovery',
      width: 1440,
      height: 900,
      direction: 'ltr',
      leafCount: 12,
      focusSide: null,
    });
    expect(poseDistance(pose, other)).toBeGreaterThan(0.3);
  });
});

describe('computeAnchors', () => {
  const viewport = { width: 1440, height: 900 };

  function pose(phase: Phase, direction: 'ltr' | 'rtl') {
    return framingFor({ phase, ...viewport, direction, leafCount: 12, focusSide: null });
  }

  it('a closed book has a book rectangle and no page rectangles', () => {
    const anchors = computeAnchors(pose('discovery', 'ltr'), viewport, {
      open: false,
      spread: 0,
      direction: 'ltr',
      leafCount: 12,
    });
    expect(anchors.book.width).toBeGreaterThan(200);
    expect(anchors.flyleaf).toBeNull();
    expect(anchors.leftPage).toBeNull();
    expect(anchors.rightPage).toBeNull();
    expect(anchors.book.x).toBeGreaterThan(0);
    expect(anchors.book.x + anchors.book.width).toBeLessThan(viewport.width);
  });

  it('the flyleaf is the right page for LTR and the left page for RTL', () => {
    const ltr = computeAnchors(pose('awaiting', 'ltr'), viewport, {
      open: true,
      spread: 0,
      direction: 'ltr',
      leafCount: 12,
    });
    expect(ltr.flyleaf).toEqual(ltr.rightPage);
    expect(ltr.leftPage!.x).toBeLessThan(ltr.rightPage!.x);
    const rtl = computeAnchors(pose('awaiting', 'rtl'), viewport, {
      open: true,
      spread: 0,
      direction: 'rtl',
      leafCount: 12,
    });
    expect(rtl.flyleaf).toEqual(rtl.leftPage);
  });

  it('after the flyleaf is turned there is no flyleaf rectangle, and the pages sit inside the book rectangle', () => {
    const anchors = computeAnchors(pose('manuscript', 'ltr'), viewport, {
      open: true,
      spread: 3,
      direction: 'ltr',
      leafCount: 12,
    });
    expect(anchors.flyleaf).toBeNull();
    const { book, leftPage, rightPage } = anchors;
    for (const page of [leftPage!, rightPage!]) {
      expect(page.x).toBeGreaterThanOrEqual(book.x - 1);
      expect(page.x + page.width).toBeLessThanOrEqual(book.x + book.width + 1);
    }
    // The two pages meet at the gutter (perspective makes their bounding boxes overlap or gap by a few pixels).
    expect(leftPage!.x).toBeLessThan(rightPage!.x);
    expect(Math.abs(leftPage!.x + leftPage!.width - rightPage!.x)).toBeLessThan(80);
  });

  it('the pages are about as wide as half the book', () => {
    const anchors = computeAnchors(pose('awaiting', 'ltr'), viewport, {
      open: true,
      spread: 0,
      direction: 'ltr',
      leafCount: 12,
    });
    expect(anchors.leftPage!.width).toBeGreaterThan(anchors.book.width * 0.4);
    expect(anchors.leftPage!.width).toBeLessThan(anchors.book.width * 0.55);
  });
});
