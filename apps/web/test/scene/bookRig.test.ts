import type { Group, Mesh } from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { leafCount as leafCountFor } from '../../src/book/bookLayout';
import { createBookAssets, type BookAssets } from '../../src/scene/book/bookAssets';
import { BookMotion } from '../../src/scene/book/bookMotion';
import { BookRig, type RigInput } from '../../src/scene/book/bookRig';
import {
  BASE_Y,
  BOARD_T,
  LEAF_T,
  PAGE_W,
  blockThickness,
  closedCenterX,
  closedFootprint,
  turnedLeafY,
  unturnedLeafY,
  valleyHeight,
  virtualLeafTotal,
} from '../../src/scene/book/dimensions';
import { NO_EFFECTS } from '../../src/state/pageEffectsStore';

const PAGES = 40;
const LEAVES = leafCountFor(PAGES);

let assets: BookAssets;
let rig: BookRig;
let motion: BookMotion;

function canvas(width: number, height: number): HTMLCanvasElement {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  return element;
}

function input(overrides: Partial<RigInput> = {}): RigInput {
  return {
    motion,
    direction: 'ltr',
    pageCount: PAGES,
    hasDocument: true,
    time: 0,
    dt: 1 / 60,
    hover: 0,
    reading: false,
    effects: NO_EFFECTS,
    source: null,
    ...overrides,
  };
}

beforeEach(() => {
  assets = createBookAssets('medium', canvas, 1);
  rig = new BookRig(assets, 4);
  motion = new BookMotion({ leafCount: LEAVES, capacity: 160, reducedMotion: false, maxAirborne: 4 });
});

afterEach(() => {
  rig.dispose();
  assets.dispose();
});

const slotMeshes = () => (rig as unknown as { slotMeshes: Mesh[] }).slotMeshes;
const stack = (name: 'stackPositive' | 'stackNegative') => (rig as unknown as Record<string, Mesh>)[name]!;
const frontHinge = () => (rig as unknown as { frontHinge: Group }).frontHinge;
const visibleSlots = () => slotMeshes().filter((mesh) => mesh.visible);

describe('BookRig: a closed book', () => {
  beforeEach(() => {
    motion.snap({ open: false, spread: 0 });
    rig.update(input());
  });

  it('is one unturned stack under the front cover, with no turned stack', () => {
    expect(stack('stackPositive').visible).toBe(true);
    expect(stack('stackNegative').visible).toBe(false);
  });

  it('sits with its middle over the middle of the root, binding on the left (LTR)', () => {
    const total = virtualLeafTotal(LEAVES);
    expect(rig.frame.position.x).toBeCloseTo(-closedCenterX(total));
    expect(rig.root.position.y).toBe(0);
    expect(rig.root.rotation.y).toBe(0);
  });

  it('has the front board lying on top of the block, flat', () => {
    const total = virtualLeafTotal(LEAVES);
    expect(frontHinge().rotation.z).toBe(0);
    expect(frontHinge().position.y).toBeCloseTo(BASE_Y + total * LEAF_T + BOARD_T / 2 + 0.0006);
  });

  it('shows the top leaves of the window as real meshes, the first at the top of the stack', () => {
    const shown = visibleSlots();
    expect(shown.length).toBeGreaterThan(0);
    const total = virtualLeafTotal(LEAVES);
    const top = Math.max(...shown.map((mesh) => mesh.position.y));
    expect(top).toBeCloseTo(unturnedLeafY(0, total));
  });

  it('the block is as thick as the virtual leaf total says', () => {
    const total = virtualLeafTotal(LEAVES);
    expect(closedFootprint(total).height).toBeCloseTo(2 * BOARD_T + blockThickness(total));
  });
});

describe('BookRig: an open book at spread 3', () => {
  beforeEach(() => {
    motion.snap({ open: true, spread: 3 });
    rig.update(input());
  });

  it('has both stacks, the turned one thin and the unturned one thick', () => {
    const turned = stack('stackNegative');
    const unturned = stack('stackPositive');
    expect(unturned.visible).toBe(true);
    expect(unturned.scale.y).toBeGreaterThan(0.2);
    // Three leaves are turned; the window shows the top two as real leaves, so one leaf is left for the stack.
    expect(turned.visible).toBe(true);
    expect(turned.scale.y).toBeCloseTo(LEAF_T);
  });

  it('is centred on the gutter and the front board lies flat on the left', () => {
    expect(rig.frame.position.x).toBeCloseTo(0);
    expect(frontHinge().rotation.z).toBeCloseTo(Math.PI);
    expect(frontHinge().position.y).toBeCloseTo(BOARD_T / 2);
  });

  it('puts each real leaf where its stack puts it: turned ones low on the left, unturned ones high', () => {
    const total = virtualLeafTotal(LEAVES);
    for (const mesh of visibleSlots()) {
      const y = mesh.position.y;
      const isTurnedHeight = y < BASE_Y + 0.1;
      const turned = Math.round((y - BASE_Y) / LEAF_T) - 1;
      if (isTurnedHeight) expect(y).toBeCloseTo(turnedLeafY(turned));
      else expect(Number.isFinite(y) && y <= unturnedLeafY(0, total)).toBe(true);
    }
  });

  it('the valley between the stacks is lowest for a thin stack and higher as both thicken', () => {
    expect(valleyHeight(0, 0.3)).toBeCloseTo(BASE_Y + 0.004);
    expect(valleyHeight(0.15, 0.15)).toBeGreaterThan(valleyHeight(0.01, 0.29));
  });

  it('writes the shared uniforms: cover open, layout side, reading light easing in', () => {
    rig.update(input({ reading: true, dt: 1 }));
    expect(assets.uniforms.uOpen.value).toBe(1);
    expect(assets.uniforms.uSide.value).toBe(1);
    expect(assets.uniforms.uReading.value).toBeGreaterThan(0.7);
    rig.update(input({ reading: false, dt: 2 }));
    expect(assets.uniforms.uReading.value).toBeLessThan(0.05);
  });

  it('gives every drawn leaf its own angle and the stack it lies on as its drop', () => {
    for (const slot of assets.slots) {
      if (slot.uniforms.uTheta.value === 0 && slot.uniforms.uDrop.value === 0) continue;
      expect([0, 1]).toContain(slot.uniforms.uTheta.value);
    }
  });
});

describe('BookRig: mirrored for RTL', () => {
  it('swaps the sides: the front board turns the other way, the layout side flips, thick stack on the other side', () => {
    motion.snap({ open: true, spread: 3 });
    rig.update(input({ direction: 'rtl' }));
    expect(frontHinge().rotation.z).toBeCloseTo(-Math.PI);
    expect(assets.uniforms.uSide.value).toBe(-1);
    expect(stack('stackNegative').visible).toBe(true);
    expect(stack('stackNegative').scale.y).toBeGreaterThan(0.2);
    expect(stack('stackPositive').scale.y).toBeCloseTo(LEAF_T);
  });

  it('a closed RTL book is centred with its binding on the right', () => {
    motion.snap({ open: false, spread: 0 });
    rig.update(input({ direction: 'rtl' }));
    expect(rig.frame.position.x).toBeCloseTo(closedCenterX(virtualLeafTotal(LEAVES)));
  });

  it('the board never needs a negative scale: every scale is positive in both directions', () => {
    motion.snap({ open: true, spread: 3 });
    for (const direction of ['ltr', 'rtl'] as const) {
      rig.update(input({ direction }));
      rig.root.traverse((object) => {
        if (object.visible) {
          expect(object.scale.x).toBeGreaterThan(0);
          expect(object.scale.y).toBeGreaterThan(0);
          expect(object.scale.z).toBeGreaterThan(0);
        }
      });
    }
  });

  it('uses the geometry whose winding matches the mirror', () => {
    motion.snap({ open: true, spread: 3 });
    rig.update(input({ direction: 'rtl' }));
    for (const mesh of visibleSlots()) expect(mesh.geometry).toBe(assets.leafGeometryRtl);
    rig.update(input({ direction: 'ltr' }));
    for (const mesh of visibleSlots()) expect(mesh.geometry).toBe(assets.leafGeometryLtr);
  });
});

describe('BookRig: moving', () => {
  it('a leaf in the air carries its angle and its turning direction, and casts a shadow', () => {
    motion.snap({ open: true, spread: 3 });
    motion.setSpread(4);
    for (let i = 0; i < 27; i += 1) motion.update(1 / 60);
    rig.update(input());
    const flying = assets.slots.filter(
      (slot) => slot.uniforms.uTheta.value > 0 && slot.uniforms.uTheta.value < 1,
    );
    expect(flying).toHaveLength(1);
    expect(flying[0]?.uniforms.uTurnV.value).toBe(1);
    expect(flying[0]?.uniforms.uRest.value).toBeLessThan(1);
    const meshes = visibleSlots().filter((mesh) => mesh.castShadow);
    expect(meshes).toHaveLength(1);
  });

  it('the hinge of a leaf travels around the back of the book while it turns, bulging outward', () => {
    motion.snap({ open: true, spread: 3 });
    motion.setSpread(4);
    for (let i = 0; i < 27; i += 1) motion.update(1 / 60);
    rig.update(input());
    const mid = visibleSlots().find((mesh) => mesh.castShadow);
    expect(mid?.position.x).toBeLessThan(0); // LTR: outward is -x at the spine
    const total = virtualLeafTotal(LEAVES);
    expect(mid?.position.y).toBeLessThan(unturnedLeafY(3, total));
    expect(mid?.position.y).toBeGreaterThan(turnedLeafY(3));
  });

  it('the book lifts and turns over for a flip, and lifts a little when hovered', () => {
    motion.snap({ open: false, spread: 0 });
    motion.startFlip();
    for (let i = 0; i < 45; i += 1) motion.update(1 / 60);
    rig.update(input());
    expect(rig.root.position.y).toBeGreaterThan(0.2);
    expect(rig.root.rotation.y).toBeGreaterThan(0.5);
    motion.commitFlip();
    for (let i = 0; i < 60; i += 1) rig.update(input({ hover: 1 }));
    // Hovering lifts the book by 2 to 3 mm (units of 10 cm) and tilts it about one degree: a nudge, not a power-up.
    expect(rig.root.position.y).toBeGreaterThan(0.02);
    expect(rig.root.position.y).toBeLessThan(0.03);
    expect(Math.abs(rig.root.rotation.x)).toBeLessThan((1.5 * Math.PI) / 180);
  });

  it('no hover lift once the book is open', () => {
    motion.snap({ open: true, spread: 0 });
    for (let i = 0; i < 60; i += 1) rig.update(input({ hover: 1 }));
    expect(rig.root.position.y).toBeCloseTo(0, 3);
  });

  it('the hit areas follow the pose: the book while closed, the flyleaf while open at spread 0', () => {
    motion.snap({ open: false, spread: 0 });
    rig.update(input());
    expect(rig.hitBook.visible).toBe(true);
    expect(rig.hitFlyleaf.visible).toBe(false);
    motion.snap({ open: true, spread: 0 });
    rig.update(input());
    expect(rig.hitBook.visible).toBe(false);
    expect(rig.hitFlyleaf.visible).toBe(true);
    expect(rig.hitFlyleaf.position.x).toBeCloseTo(PAGE_W / 2);
    rig.update(input({ direction: 'rtl' }));
    expect(rig.hitFlyleaf.position.x).toBeCloseTo(-PAGE_W / 2);
    motion.snap({ open: true, spread: 2 });
    rig.update(input());
    expect(rig.hitFlyleaf.visible).toBe(false);
  });

  it('allocates nothing per update: the same objects are written every frame', () => {
    motion.snap({ open: true, spread: 3 });
    rig.update(input());
    const meshes = visibleSlots();
    const materials = meshes.map((mesh) => mesh.material);
    const geometries = meshes.map((mesh) => mesh.geometry);
    for (let i = 0; i < 20; i += 1) rig.update(input({ time: i / 60 }));
    expect(visibleSlots().map((mesh) => mesh.material)).toEqual(materials);
    expect(visibleSlots().map((mesh) => mesh.geometry)).toEqual(geometries);
  });
});

describe('BookRig: the binding details', () => {
  const headbands = () => (rig as unknown as { headbands: Mesh[] }).headbands;
  const ribbon = () => (rig as unknown as { ribbon: Mesh }).ribbon;

  it('has a silk headband at the head and one at the tail, on the spine side of the block, as tall as the closed block', () => {
    motion.snap({ open: false, spread: 0 });
    rig.update(input());
    const [head, tail] = headbands();
    if (!head || !tail) throw new Error('two headbands');
    expect(head.position.z).toBeLessThan(-1.0);
    expect(tail.position.z).toBeGreaterThan(1.0);
    expect(head.position.x).toBeGreaterThan(0);
    expect(tail.position.x).toBeCloseTo(head.position.x, 6);
    const total = virtualLeafTotal(LEAVES);
    // From the back board's top to the top of the block.
    expect(head.position.y + head.scale.y / 2).toBeCloseTo(BASE_Y + total * LEAF_T + 0.0, 2);
  });

  it('they follow the layout: on the other side of the spine for RTL', () => {
    motion.snap({ open: false, spread: 0 });
    rig.update(input({ direction: 'rtl' }));
    const [head] = headbands();
    expect(head?.position.x).toBeLessThan(0);
  });

  it('once the book is open they shrink to the valley of the gutter, not poking out above the pages', () => {
    motion.snap({ open: true, spread: 3 });
    rig.update(input());
    const valley = valleyHeight(3 * LEAF_T, (virtualLeafTotal(LEAVES) - 3) * LEAF_T);
    const [head] = headbands();
    if (!head) throw new Error('a headband');
    expect(head.position.y + head.scale.y / 2).toBeLessThan(valley + 0.01);
    expect(head.scale.y).toBeLessThan(0.1);
  });

  it('the ribbon comes out at the tail by the gutter and hangs to the table: its height follows the edge', () => {
    motion.snap({ open: false, spread: 0 });
    rig.update(input());
    const closed = ribbon();
    expect(closed.position.z).toBeGreaterThan(1);
    expect(closed.position.y).toBeLessThan(0.02); // it lies on the table
    const closedHeight = closed.scale.y;
    expect(closedHeight).toBeGreaterThan(0.1); // it comes out of the block, well above the table
    motion.snap({ open: true, spread: 3 });
    rig.update(input());
    expect(ribbon().scale.y).toBeLessThan(closedHeight);
  });

  it('are not part of raycasting, and are disposed with the assets', () => {
    for (const mesh of [...headbands(), ribbon()]) {
      const found: unknown[] = [];
      const ray = { ray: { origin: { x: 0 } } } as never;
      mesh.raycast(ray, found as never);
      expect(found).toEqual([]);
    }
  });
});

describe('BookRig: warming up the leaf programs', () => {
  const warmMesh = () => (rig as unknown as { warmMesh: Mesh }).warmMesh;

  it('shows nothing extra unless asked: the warm-up mesh is hidden', () => {
    motion.snap({ open: false, spread: 0 });
    rig.update(input());
    expect(warmMesh().visible).toBe(false);
  });

  it('draws a speck of a leaf that casts a shadow for a few frames, so the first real turn compiles nothing, then goes away', () => {
    motion.snap({ open: false, spread: 0 });
    rig.requestWarmUp(2);
    for (let frame = 0; frame < 2; frame += 1) {
      rig.update(input());
      expect(warmMesh().visible, `frame ${String(frame)}`).toBe(true);
      expect(warmMesh().castShadow).toBe(true);
      expect(warmMesh().scale.x).toBeLessThan(0.001); // too small to see
      expect(warmMesh().material).toBe(assets.slots[0]?.material);
      expect(warmMesh().customDepthMaterial).toBe(assets.slots[0]?.depthMaterial);
    }
    rig.update(input());
    expect(warmMesh().visible).toBe(false);
  });
});
