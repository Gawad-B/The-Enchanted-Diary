import { describe, expect, it } from 'vitest';
import {
  PAGE_H,
  PAGE_W,
  turnedLeafY,
  unturnedLeafY,
  virtualLeafTotal,
  BASE_Y,
} from '../../src/scene/book/dimensions';
import {
  HINGE_BULGE,
  LEAF_BEND_STEPS,
  LEAF_BOW,
  LEAF_LAG_EXPONENT,
  LEAF_LAG_GAIN,
  hingeOffset,
  leafPoint,
  leafReachOutline,
  type ReachPoint,
} from '../../src/scene/book/leafReach';
import { LEAF_BEND_GLSL } from '../../src/scene/book/shaderChunks';

/*
 * What a turning leaf really does: the hinge rides round the back of the stack at mid-block height and the leaf's bend
 * carries its free edge past the vertical on a turn back. The camera frames this reach, so the arithmetic must be the
 * rig's and the shader's.
 */

const out = { x: 0, y: 0 };

describe('the leaf bend, in TypeScript', () => {
  it('a leaf at rest lies flat, to the side it lies on', () => {
    expect(leafPoint(PAGE_W, 0, 0, 1, { ...out })).toEqual({ x: PAGE_W, y: 0 });
    const turned = leafPoint(PAGE_W, 0, 1, 1, { ...out });
    expect(turned.x).toBeCloseTo(-PAGE_W, 9);
    expect(turned.y).toBeCloseTo(0, 9);
  });

  it("a leaf standing upright that is not turning is straight: its edge is a page's width over the hinge", () => {
    const edge = leafPoint(PAGE_W, 0, 0.5, 0, { ...out });
    expect(edge.x).toBeCloseTo(0, 9);
    expect(edge.y).toBeCloseTo(PAGE_W, 9);
  });

  it('the lag trails the motion: a forward turn leans back towards where it came from, a turn back leans over the other way and is lower', () => {
    const forward = leafPoint(PAGE_W, 0, 0.5, 1, { ...out });
    const back = leafPoint(PAGE_W, 0, 0.5, -1, { ...out });
    expect(forward.x).toBeGreaterThan(0.1);
    expect(back.x).toBeLessThan(-0.1);
    expect(forward.x).toBeCloseTo(-back.x, 9);
    expect(forward.y).toBeLessThan(PAGE_W);
    // The turn back is carried past the vertical at a later angle, where it is higher than a straight leaf could be.
    let highest = 0;
    for (let step = 0; step <= 200; step += 1) {
      highest = Math.max(highest, leafPoint(PAGE_W, 0, step / 200, -1, { ...out }).y);
    }
    expect(highest).toBeLessThanOrEqual(PAGE_W + 1e-9);
  });

  it('the head and the tail trail the middle (the bow), and the middle does not', () => {
    const middle = leafPoint(PAGE_W, 0, 0.4, 1, { ...out });
    const head = leafPoint(PAGE_W, -PAGE_H / 2, 0.4, 1, { ...out });
    const tail = leafPoint(PAGE_W, PAGE_H / 2, 0.4, 1, { ...out });
    expect(Math.hypot(head.x - middle.x, head.y - middle.y)).toBeGreaterThan(0.005);
    expect(head.x).toBeCloseTo(tail.x, 9);
    expect(head.y).toBeCloseTo(tail.y, 9);
  });
});

describe('the hinge, in TypeScript (the rig calls it)', () => {
  it('starts on the unturned stack, ends on the turned one, and rides at mid-block height in between, bulging outward round the back', () => {
    const total = 150;
    const leaf = 10;
    const unturned = unturnedLeafY(leaf, total);
    const turned = turnedLeafY(leaf);
    expect(hingeOffset(unturned, turned, 0, 1, { ...out }).y).toBeCloseTo(unturned, 9);
    expect(hingeOffset(unturned, turned, 1, 1, { ...out }).y).toBeCloseTo(turned, 9);
    const middle = hingeOffset(unturned, turned, 0.5, 1, { ...out });
    expect(middle.y).toBeCloseTo((unturned + turned) / 2, 9);
    expect(middle.x).toBeCloseTo(-HINGE_BULGE * ((unturned - turned) / 2), 9);
    // Mirrored for the other layout.
    expect(hingeOffset(unturned, turned, 0.5, -1, { ...out }).x).toBeCloseTo(-middle.x, 9);
  });
});

describe('the shader and the TypeScript read the same constants', () => {
  it("the vertex shader's bend is written from them (so the camera's reach cannot drift from what is drawn)", () => {
    expect(LEAF_BEND_GLSL).toContain(`k * ${LEAF_LAG_GAIN.toFixed(5)}`);
    expect(LEAF_BEND_GLSL).toContain(`pow(u, ${LEAF_LAG_EXPONENT.toFixed(5)})`);
    expect(LEAF_BEND_GLSL).toContain(`pow(uEnd, ${LEAF_LAG_EXPONENT.toFixed(5)})`);
    expect(LEAF_BEND_GLSL).toContain(`i < ${String(LEAF_BEND_STEPS)}`);
    expect(LEAF_BEND_GLSL).toContain(`float ds = s / ${LEAF_BEND_STEPS.toFixed(5)}`);
    expect(LEAF_BEND_GLSL).toContain(`k * ${LEAF_BOW.toFixed(5)}`);
  });
});

describe("the outline a book's turning leaves sweep through", () => {
  const heightOf = (leafCount: number): number =>
    Math.max(...leafReachOutline(leafCount, virtualLeafTotal(leafCount)).map((point) => point.y));

  it("rises with the thickness of the block: a thin book stands about a page's width and a half over the table, a 300-page one near 1.8", () => {
    const thin = heightOf(10);
    const hundred = heightOf(100);
    const thick = heightOf(150);
    expect(thin).toBeGreaterThan(PAGE_W);
    expect(hundred).toBeGreaterThan(thin - 1e-9);
    expect(thick).toBeGreaterThan(hundred + 0.05);
    // The reviewer's port of the rig and the shader: 1.70 up to 100 leaves, 1.79 at 150 (plus our margin of 0.03).
    expect(hundred).toBeGreaterThan(1.7);
    expect(hundred).toBeLessThan(1.8);
    expect(thick).toBeGreaterThan(1.79);
    expect(thick).toBeLessThan(1.9);
  });

  it('holds every point the free edge of any leaf reaches, forward or back, head, tail or middle (a convex outline), mirrored either way', () => {
    for (const leafCount of [1, 40, 150]) {
      const total = virtualLeafTotal(leafCount);
      const outline = leafReachOutline(leafCount, total);
      // counter-clockwise: every point is on the left of every edge
      const inside = (p: ReachPoint): boolean =>
        outline.every((a, i) => {
          const b = outline[(i + 1) % outline.length] ?? a;
          return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= -1e-9;
        });
      const hinge = { x: 0, y: 0 };
      const tip = { x: 0, y: 0 };
      for (let leaf = 0; leaf < leafCount; leaf += Math.max(1, Math.floor(leafCount / 12))) {
        for (let step = 0; step <= 100; step += 1) {
          const theta = step / 100;
          hingeOffset(unturnedLeafY(leaf, total), turnedLeafY(leaf), theta, 1, hinge);
          for (const turnV of [1, -1]) {
            for (const z of [-PAGE_H / 2, 0, PAGE_H / 2]) {
              leafPoint(PAGE_W, z, theta, turnV, tip);
              for (const side of [1, -1]) {
                expect(
                  inside({ x: side * (hinge.x + tip.x), y: hinge.y + tip.y }),
                  `leaf ${String(leaf)} θ ${String(theta)} ${String(turnV)}`,
                ).toBe(true);
              }
            }
          }
        }
      }
    }
  });

  it('is memoised (the framing asks for it every time the camera is placed)', () => {
    expect(leafReachOutline(150, 170)).toBe(leafReachOutline(150, 170));
  });

  it('never dips below the block it sits on: it starts at the top of the page block', () => {
    const outline = leafReachOutline(150, 170);
    expect(Math.min(...outline.map((point) => point.y))).toBeGreaterThan(BASE_Y - 0.1);
  });

  describe('the two-leaf hull', () => {
    /** The outline the slow way, as it used to be built: the free edge of EVERY leaf at every angle, then the same hull. */
    function everyLeafOutline(leafCount: number, total: number): ReachPoint[] {
      const hingeAt = { x: 0, y: 0 };
      const tip = { x: 0, y: 0 };
      const cloud: ReachPoint[] = [];
      for (let leaf = 0; leaf < leafCount; leaf += 1) {
        for (let step = 0; step <= 100; step += 1) {
          const theta = step / 100;
          hingeOffset(unturnedLeafY(leaf, total), turnedLeafY(leaf), theta, 1, hingeAt);
          for (const turnV of [1, -1]) {
            for (const z of [-PAGE_H / 2, 0]) {
              leafPoint(PAGE_W, z, theta, turnV, tip);
              cloud.push({ x: hingeAt.x + tip.x, y: hingeAt.y + tip.y });
            }
          }
        }
      }
      const hull = (points: ReachPoint[]): ReachPoint[] => {
        const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
        const turn = (o: ReachPoint, a: ReachPoint, b: ReachPoint): number =>
          (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
        const half = (list: ReachPoint[]): ReachPoint[] => {
          const kept: ReachPoint[] = [];
          for (const p of list) {
            while (kept.length >= 2) {
              const b = kept[kept.length - 1];
              const a = kept[kept.length - 2];
              if (!a || !b || turn(a, b, p) > 0) break;
              kept.pop();
            }
            kept.push(p);
          }
          kept.pop();
          return kept;
        };
        return [...half(sorted), ...half([...sorted].reverse())];
      };
      const padded: ReachPoint[] = [];
      for (const p of hull(cloud)) {
        for (const side of [1, -1]) {
          for (const dx of [-0.03, 0.03]) {
            for (const dy of [-0.03, 0.03]) padded.push({ x: side * p.x + dx, y: p.y + dy });
          }
        }
      }
      return hull(padded);
    }

    it('is the same outline, vertex for vertex, as sweeping every leaf (1, 2, 21, 100 and 151 leaves)', () => {
      for (const leafCount of [1, 2, 21, 100, 151]) {
        const total = virtualLeafTotal(leafCount);
        const fast = leafReachOutline(leafCount, total);
        const slow = everyLeafOutline(leafCount, total);
        expect(fast.length, `${String(leafCount)} leaves: vertex count`).toBe(slow.length);
        fast.forEach((point, index) => {
          expect(point.x).toBeCloseTo(slow[index]?.x ?? Number.NaN, 9);
          expect(point.y).toBeCloseTo(slow[index]?.y ?? Number.NaN, 9);
        });
      }
    });

    it('costs the same for a 300-page book as for a thin one, and little (a cold build was a 25 to 260 ms task)', () => {
      // Distinct totals keep every build cold (the outline is memoised per leaf count and total).
      const cold = (leafCount: number, bump: number): number => {
        const started = performance.now();
        leafReachOutline(leafCount, virtualLeafTotal(leafCount) + bump);
        return performance.now() - started;
      };
      cold(2, 900); // warms the JIT so the first sample is not the odd one out
      const best = (leafCount: number, bump: number): number =>
        Math.min(...[0, 1, 2, 3, 4].map((run) => cold(leafCount, bump + run)));
      const thin = best(2, 1000);
      const thick = best(151, 2000);
      // A sweep of every leaf is about 75 times the work at 151 leaves; the two-leaf hull is the same work at any count.
      expect(thick).toBeLessThan(thin * 3 + 4);
      expect(thick).toBeLessThan(25);
    });
  });
});
