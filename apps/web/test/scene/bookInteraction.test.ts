import { Box3, Raycaster, Vector3, type Mesh, type Object3D } from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { leafCount as leafCountFor } from '../../src/book/bookLayout';
import { createBookAssets, type BookAssets } from '../../src/scene/book/bookAssets';
import { interactionFor } from '../../src/scene/book/interaction';
import { BookMotion } from '../../src/scene/book/bookMotion';
import { BookRig, type RigInput } from '../../src/scene/book/bookRig';
import { NO_EFFECTS } from '../../src/state/pageEffectsStore';

/*
 * Pointer interaction with the 3D book: only the two hit areas answer a raycast (so hovering a page never
 * "leaves" the book), an invisible hit area answers nothing, and the phase decides what a hit means.
 */

const PAGES = 40;
let assets: BookAssets;
let rig: BookRig;
let motion: BookMotion;

function canvas(width: number, height: number): HTMLCanvasElement {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  return element;
}

function update(): void {
  const input: RigInput = {
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
  };
  rig.update(input);
  rig.root.updateMatrixWorld(true);
}

/** Objects hit by a ray falling straight down at (x, z). */
function hitsAt(x: number, z: number): Object3D[] {
  const raycaster = new Raycaster(new Vector3(x, 5, z), new Vector3(0, -1, 0));
  return raycaster.intersectObject(rig.root, true).map((hit) => hit.object);
}

beforeEach(() => {
  assets = createBookAssets('medium', canvas, 1);
  rig = new BookRig(assets, 4);
  motion = new BookMotion({
    leafCount: leafCountFor(PAGES),
    capacity: 160,
    reducedMotion: false,
    maxAirborne: 4,
  });
});

afterEach(() => {
  rig.dispose();
  assets.dispose();
});

describe('what a raycast can hit', () => {
  it('on a closed book only the hit box answers, however many meshes the book is made of', () => {
    motion.snap({ open: false, spread: 0 });
    update();
    const hits = hitsAt(0.7, 0);
    expect(hits).toEqual([rig.hitBook]);
  });

  it('on an open book at spread 0 only the flyleaf area answers (the closed-book box is invisible and silent)', () => {
    motion.snap({ open: true, spread: 0 });
    update();
    expect(hitsAt(0.7, 0)).toEqual([rig.hitFlyleaf]);
  });

  it('a hit area that is not visible answers nothing, and the pages of a read book answer nothing', () => {
    motion.snap({ open: true, spread: 3 });
    update();
    expect(hitsAt(0.7, 0)).toEqual([]);
    expect(hitsAt(-0.7, 0)).toEqual([]);
  });

  it('no visual mesh of the book (boards, stacks, spine, leaves, shadow) takes part in raycasting', () => {
    motion.snap({ open: true, spread: 3 });
    motion.setSpread(4);
    motion.update(0.35); // a leaf is in the air
    update();
    const checked: string[] = [];
    rig.root.traverse((object) => {
      if (!('isMesh' in object)) return;
      const mesh = object as Mesh;
      if (mesh === rig.hitBook || mesh === rig.hitFlyleaf || !mesh.visible) return;
      const box = new Box3().setFromObject(mesh);
      if (box.isEmpty()) return;
      const centre = box.getCenter(new Vector3());
      const raycaster = new Raycaster(new Vector3(centre.x, box.max.y + 2, centre.z), new Vector3(0, -1, 0));
      checked.push(mesh.name || mesh.geometry.type);
      expect(raycaster.intersectObject(mesh, false), mesh.name || mesh.geometry.type).toEqual([]);
    });
    expect(checked.length).toBeGreaterThan(4);
  });
});

describe('interactionFor: what a hit means in a phase', () => {
  it('discovery: the book is the door', () => {
    expect(interactionFor('discovery', rig.hitBook, rig)).toBe('open-book');
    expect(interactionFor('discovery', rig.hitFlyleaf, rig)).toBeNull();
  });

  it('awaiting: the flyleaf chooses a manuscript', () => {
    expect(interactionFor('awaiting', rig.hitFlyleaf, rig)).toBe('choose-manuscript');
    expect(interactionFor('awaiting', rig.hitBook, rig)).toBeNull();
  });

  it('nothing else is interactive, and an unknown object is never a hit', () => {
    for (const phase of ['opening', 'uploading', 'reading', 'unveiling', 'manuscript', 'closing'] as const) {
      expect(interactionFor(phase, rig.hitBook, rig), phase).toBeNull();
      expect(interactionFor(phase, rig.hitFlyleaf, rig), phase).toBeNull();
    }
    expect(interactionFor('discovery', rig.frame, rig)).toBeNull();
  });
});
