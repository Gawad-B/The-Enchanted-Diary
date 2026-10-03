import {
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  type Intersection,
  type Raycaster,
  type Texture,
} from 'three';
import type { Direction } from '@enchanted/shared';
import {
  coverFrame,
  isDiaryFace,
  leafCount as leafCountFor,
  leafFrame,
  leafFaces,
} from '../../book/bookLayout';
import type { LeafFace } from '../../book/bookLayout';
import { diarySourceRegistry } from '../../book/diaryPages';
import type { PageTextureSource } from '../../book/pageSource';
import { clamp01, damp, lerp, smoothstep } from '../easing';
import { BOARD_HINGE_GAP, BOARD_WIDTH, type BookAssets } from './bookAssets';
import { writeEffectUniforms } from './bookUniforms';
import type { StackUniforms } from './bookMaterials';
import type { BookMotion } from './bookMotion';
import {
  BASE_Y,
  BOARD_OVERHANG,
  BOARD_T,
  LEAF_T,
  PAGE_H,
  PAGE_W,
  closedCenterX,
  closedFootprint,
  openFootprint,
  spineBulge,
  turnedLeafY,
  unturnedLeafY,
  valleyHeight,
  virtualLeafTotal,
} from './dimensions';
import { createLeafPlan, planLeaves, turnBoundary, type LeafPlan } from './leafPlan';
import { LEAF_BEND, hingeOffset } from './leafReach';
import { updateSpineGeometry } from './spineGeometry';
import type { EffectValues } from '../../state/pageEffectsStore';

/*
 * The 3D book as a plain object graph. React mounts `root` once; every frame `update` writes the pose of the
 * boards, the spine, the two page-block stacks and the leaf slots from a BookMotion, without creating
 * anything. See bookMotion.ts for the numbers and leafPlan.ts for which leaves are real meshes.
 *
 * Frames (global section G): the spine axis is at x = 0 and runs along z. `outward` is +1 for an LTR layout
 * (unturned leaves extend towards +x, the binding is on the left) and -1 for RTL. A leaf's hinge is not
 * a fixed point: it travels around the rounded back of the book from the height of the leaf on the unturned
 * stack to its height on the turned stack, bulging outward by a fraction of the difference.
 */

/** How far the closed book lifts when hovered (2.5 mm): a nudge, not a power-up. */
const HOVER_LIFT = 0.025;
const FLIP_LIFT = 0.9;
/** A thin stack's pages bow up out of the gutter by this much (7.5 mm), fading away as the stack thickens. */
const MAX_ARCH = 0.075;
/** Where the silk headbands and the ribbon sit across the spine side of the block (scene units from the spine). */
const HEADBAND_X = 0.044;
const RIBBON_X = 0.075;
/** The ribbon lies on the table (a hair above it). */
const RIBBON_TABLE_Y = 0.006;

/** How far a stack of the given height (scene units, the leaves only) bows up out of the gutter. */
export function archFor(stackHeight: number): number {
  const t = clamp01((stackHeight - 0.01) / 0.1);
  return MAX_ARCH * (1 - t * t * (3 - 2 * t));
}

export interface RigInput {
  motion: BookMotion;
  direction: Direction;
  pageCount: number;
  hasDocument: boolean;
  /** Diary leaves bound before the flyleaf (global section T); none when absent. */
  diaryLeaves?: number;
  time: number;
  dt: number;
  /** 0..1 pointer-over amount of the closed book. */
  hover: number;
  /** Whether the pages are in a reading framing (the reading light mixes in). */
  reading: boolean;
  effects: Readonly<EffectValues>;
  source: PageTextureSource | null;
}

/** Visual meshes take no part in raycasting: only the hit areas answer a pointer (and a cast costs nothing). */
function noRaycast(): void {
  // intentionally empty
}

/** A hit area answers a raycast only while it is visible (three's Raycaster ignores `visible`). */
function raycastWhileVisible(mesh: Mesh): void {
  mesh.raycast = (raycaster: Raycaster, intersects: Intersection[]) => {
    if (mesh.visible) Mesh.prototype.raycast.call(mesh, raycaster, intersects);
  };
}

function hash(index: number, salt: number): number {
  const value = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453;
  return value - Math.floor(value);
}

export class BookRig {
  readonly root = new Group();
  readonly frame = new Group();
  /** Invisible box over the closed book for hover and click. */
  readonly hitBook: Mesh;
  /** Invisible plane over the unturned page at spread 0 (the flyleaf's invitation). */
  readonly hitFlyleaf: Mesh;
  /** Soft contact shadow on the table; not a child of `root` so it stays on the table when the book lifts. */
  readonly shadow: Mesh;

  private readonly assets: BookAssets;
  private readonly plan: LeafPlan;
  private readonly animatedLeaves: number;
  private readonly slotMeshes: Mesh[];
  private readonly slotLeafShown: Int16Array;
  private readonly stackPositive: Mesh;
  private readonly stackNegative: Mesh;
  private readonly backBoard: Mesh;
  private readonly frontHinge = new Group();
  private readonly frontBoard: Mesh;
  private readonly spine: Mesh;
  private readonly headbands: Mesh[];
  private readonly ribbon: Mesh;
  /** A speck of a leaf drawn for a few frames at mount, so the leaf programs (and their shadow program) compile then. */
  readonly warmMesh: Mesh;
  private warmFrames = 0;
  private readonly hitMaterial = new MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    colorWrite: false,
  });
  private readonly hitGeometry = new BoxGeometry(1, 1, 1);
  private readonly hingeScratch = { x: 0, y: 0 };
  private lastSpineHeight = Number.NaN;
  private lastSpineOutward: 1 | -1 | null = null;
  private lastDirection: Direction | null = null;
  private readingMix = 0;
  private hoverMix = 0;
  private sourceVersion = 0;
  private lastSourceVersion = -1;

  constructor(assets: BookAssets, animatedLeaves: number) {
    this.assets = assets;
    this.animatedLeaves = animatedLeaves;
    this.plan = createLeafPlan(assets.slotCount);
    this.slotLeafShown = new Int16Array(assets.slotCount).fill(-2);
    this.root.name = 'diary';
    this.frame.name = 'diary-frame';
    this.root.add(this.frame);

    const { leather } = assets;
    // A box's faces: +x, -x, +y, -y, +z, -z. The front board shows its art when closed (+y) and the endpaper inside
    // (-y); the back board is the other way up: the endpaper faces the pages (+y), the art faces the table (-y).
    const frontMaterials = [
      leather.plain,
      leather.plain,
      leather.art,
      assets.endpaper,
      leather.plain,
      leather.plain,
    ];
    const backMaterials = [
      leather.plain,
      leather.plain,
      assets.endpaper,
      leather.art,
      leather.plain,
      leather.plain,
    ];
    this.backBoard = new Mesh(assets.boardGeometry, backMaterials);
    this.backBoard.castShadow = true;
    this.backBoard.receiveShadow = true;
    this.frontBoard = new Mesh(assets.boardGeometry, frontMaterials);
    this.frontBoard.castShadow = true;
    this.frontBoard.receiveShadow = true;
    this.frontHinge.add(this.frontBoard);
    this.spine = new Mesh(assets.spineGeometry, assets.spineMaterial);
    this.spine.castShadow = true;
    this.spine.receiveShadow = true;
    this.spine.frustumCulled = false;
    this.stackPositive = new Mesh(assets.stackGeometry, assets.stackPositive.materials);
    this.stackNegative = new Mesh(assets.stackGeometry, assets.stackNegative.materials);
    for (const stack of [this.stackPositive, this.stackNegative]) {
      stack.castShadow = true;
      stack.receiveShadow = true;
      stack.frustumCulled = false;
    }
    this.slotMeshes = assets.slots.map((slot) => {
      const mesh = new Mesh(assets.leafGeometryLtr, slot.material);
      mesh.customDepthMaterial = slot.depthMaterial;
      mesh.customDistanceMaterial = slot.distanceMaterial;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.frustumCulled = false;
      mesh.visible = false;
      return mesh;
    });
    this.headbands = [-1, 1].map((end) => {
      const band = new Mesh(assets.binding.headbandGeometry, assets.binding.headbandMaterial);
      band.name = end < 0 ? 'headband-head' : 'headband-tail';
      band.castShadow = false;
      band.frustumCulled = false;
      return band;
    });
    const firstSlot = assets.slots[0];
    this.warmMesh = new Mesh(assets.leafGeometryLtr, firstSlot?.material);
    this.warmMesh.name = 'warm-up';
    if (firstSlot) this.warmMesh.customDepthMaterial = firstSlot.depthMaterial;
    this.warmMesh.castShadow = true;
    this.warmMesh.visible = false;
    this.warmMesh.frustumCulled = false;
    this.warmMesh.scale.setScalar(1e-4);
    this.ribbon = new Mesh(assets.binding.ribbonGeometry, assets.binding.ribbonMaterial);
    this.ribbon.name = 'ribbon';
    this.ribbon.castShadow = true;
    this.ribbon.receiveShadow = true;
    this.ribbon.frustumCulled = false;
    this.hitBook = new Mesh(this.hitGeometry, this.hitMaterial);
    this.hitBook.name = 'hit-book';
    this.hitFlyleaf = new Mesh(this.hitGeometry, this.hitMaterial);
    this.hitFlyleaf.name = 'hit-flyleaf';
    this.hitFlyleaf.visible = false;
    raycastWhileVisible(this.hitBook);
    raycastWhileVisible(this.hitFlyleaf);
    this.shadow = new Mesh(assets.shadowGeometry, assets.shadowMaterial);
    this.shadow.name = 'diary-contact-shadow';
    this.shadow.position.y = 0.004;
    this.shadow.renderOrder = 1;
    this.shadow.frustumCulled = false;

    for (const visual of [
      this.backBoard,
      this.frontBoard,
      this.spine,
      this.stackPositive,
      this.stackNegative,
      ...this.slotMeshes,
      ...this.headbands,
      this.ribbon,
      this.warmMesh,
      this.shadow,
    ]) {
      visual.raycast = noRaycast;
    }
    this.frame.add(
      this.backBoard,
      this.frontHinge,
      this.spine,
      this.stackPositive,
      this.stackNegative,
      ...this.slotMeshes,
      ...this.headbands,
      this.ribbon,
      this.warmMesh,
      this.hitBook,
      this.hitFlyleaf,
    );
  }

  /**
   * Where the hinge is along its arc round the back of the book. The result lives in one scratch object that
   * is overwritten by the next call (the frame loop calls this for every leaf: nothing is allocated).
   */
  private hingePose(
    unturnedY: number,
    turnedY: number,
    theta: number,
    outward: number,
  ): { x: number; y: number } {
    return hingeOffset(unturnedY, turnedY, theta, outward, this.hingeScratch);
  }

  /**
   * Draws a speck of a leaf, casting a shadow, for `frames` frames. The first frame a leaf flies compiles its program
   * and its shadow program (a hitch of tens of milliseconds); doing it at mount, when nobody is watching, moves it there.
   */
  requestWarmUp(frames = 3): void {
    this.warmFrames = frames;
  }

  /** Marks the source's textures as changed so every slot re-reads them on the next frame. */
  invalidateTextures(): void {
    this.sourceVersion += 1;
  }

  update(input: RigInput): void {
    const { motion, direction, pageCount, hasDocument, source } = input;
    const diaryLeaves = input.diaryLeaves ?? 0;
    const frame = leafFrame(direction);
    const cover = coverFrame(direction);
    const outward = frame.outward;
    const { uniforms } = this.assets;
    const leaves = leafCountFor(pageCount, diaryLeaves);
    const total = virtualLeafTotal(leaves);
    const open = clamp01(motion.cover.value);

    // Shared uniforms: one write per frame updates every material of the book.
    uniforms.uSide.value = outward;
    uniforms.uOpen.value = open;
    uniforms.uTime.value = input.time;
    this.readingMix = damp(this.readingMix, input.reading ? 0.78 : 0, 5, input.dt);
    uniforms.uReading.value = this.readingMix;
    writeEffectUniforms(uniforms, input.effects);

    const directionChanged = this.lastDirection !== direction;
    this.lastDirection = direction;
    const sourceChanged = this.lastSourceVersion !== this.sourceVersion;
    this.lastSourceVersion = this.sourceVersion;

    // Leaf slots.
    planLeaves(motion.thetas, motion.leafCount, this.animatedLeaves, this.plan);
    // The stacks the real leaves lie on: the leaves with no slot, plus the filler leaves at the back.
    const unturnedHeight = (this.plan.unturnedStack + Math.max(0, total - leaves)) * LEAF_T;
    const turnedHeight = this.plan.turnedStack * LEAF_T;
    // Both stacks slope down into one valley at the spine: its height follows the thinner stack. A leaf takes
    // the slope of the stack it lies on (so it stays the same small distance above it all the way in).
    const turnedLeaves = turnBoundary(motion.thetas, motion.leafCount);
    const valley = valleyHeight(turnedLeaves * LEAF_T, (total - turnedLeaves) * LEAF_T);
    const dropUnturned = Math.max(0, BASE_Y + unturnedHeight - valley);
    const dropTurned = Math.max(0, BASE_Y + turnedHeight - valley);
    const archUnturned = archFor(unturnedHeight);
    const archTurned = archFor(turnedHeight);
    const geometry = direction === 'ltr' ? this.assets.leafGeometryLtr : this.assets.leafGeometryRtl;
    // The leaf that is turning throws a soft shadow on the pages under it (read by the page shaders).
    let turnAngle = 0;
    let turnAmount = 0;
    const blank = source?.getTexture('blank') ?? this.assets.fallbackPaper;
    for (let slotIndex = 0; slotIndex < this.slotMeshes.length; slotIndex += 1) {
      const mesh = this.slotMeshes[slotIndex];
      const slot = this.assets.slots[slotIndex];
      if (!mesh || !slot) continue;
      const leaf = this.plan.slotLeaf[slotIndex] ?? -1;
      if (leaf < 0) {
        mesh.visible = false;
        this.slotLeafShown[slotIndex] = -2;
        continue;
      }
      const theta = clamp01(motion.thetas[leaf] ?? 0);
      const unturnedY = unturnedLeafY(leaf, total);
      const turnedY = turnedLeafY(leaf);
      const hinge = this.hingePose(unturnedY, turnedY, theta, outward);
      mesh.visible = true;
      mesh.position.set(hinge.x, hinge.y, 0);
      if (mesh.geometry !== geometry) mesh.geometry = geometry;
      const flying = theta > 1e-4 && theta < 1 - 1e-4;
      mesh.castShadow = flying;
      if (flying) {
        const lift = Math.sin(Math.PI * theta) ** 0.8;
        if (lift > turnAmount) {
          turnAmount = lift;
          turnAngle = theta;
        }
      }
      const u = slot.uniforms;
      u.uTheta.value = theta;
      u.uBend.value = LEAF_BEND;
      u.uTurnV.value = motion.turnSigns[leaf] ?? 0;
      u.uRest.value = 1 - smoothstep(0, 0.1, Math.min(theta, 1 - theta));
      u.uDrop.value = theta < 0.5 ? dropUnturned : dropTurned;
      u.uArch.value = theta < 0.5 ? archUnturned : archTurned;
      u.uJitter.value.set(
        (hash(leaf, 1) - 0.65) * 0.01,
        (hash(leaf, 2) - 0.5) * 0.008,
        (hash(leaf, 3) - 0.5) * 0.0005,
        0.965 + hash(leaf, 4) * 0.07,
      );
      if (this.slotLeafShown[slotIndex] !== leaf || sourceChanged || directionChanged) {
        this.slotLeafShown[slotIndex] = leaf;
        const faces = leafFaces(leaf, pageCount, hasDocument, diaryLeaves);
        // The flyleaf's invitation is never shown: the upload is a page in the middle of the book (a plain one).
        if (faces.front === 'flyleaf') faces.front = 'blank';
        u.uFrontMap.value = this.textureFor(source, faces.front, blank);
        u.uBackMap.value = this.textureFor(source, faces.back, blank);
      }
    }
    uniforms.uTurnAng.value = turnAngle;
    uniforms.uTurnAmount.value = turnAmount;
    // The leaves that are still arriving texture by texture should keep asking until they are ready.
    if (sourceChanged || directionChanged) {
      this.assets.endpaper.map = source?.getTexture('endpaper') ?? this.assets.fallbackPaper;
    }

    // Stacks: the unturned one (with the leaves behind the real ones and the filler) and the turned one.
    const positiveIsUnturned = outward === 1;
    this.placeStack(
      this.stackPositive,
      this.assets.stackPositive.uniforms,
      positiveIsUnturned ? unturnedHeight : turnedHeight,
      1,
      valley,
      positiveIsUnturned ? 0 : 1,
    );
    this.placeStack(
      this.stackNegative,
      this.assets.stackNegative.uniforms,
      positiveIsUnturned ? turnedHeight : unturnedHeight,
      -1,
      valley,
      positiveIsUnturned ? 1 : 0,
    );
    // The turned stack only exists once the cover is open enough to lay leaves down.
    const turnedStack = positiveIsUnturned ? this.stackNegative : this.stackPositive;
    turnedStack.visible = turnedStack.visible && open > 0.02;

    // Boards. The back board never moves; the front board swings about the hinge.
    const outwardX = outward * (BOARD_WIDTH / 2 - BOARD_HINGE_GAP);
    this.backBoard.position.set(outwardX, BOARD_T / 2, 0);
    const closedY = BASE_Y + total * LEAF_T + BOARD_T / 2 + 0.0006;
    const hinge = this.hingePose(closedY, BOARD_T / 2, open, outward);
    this.frontHinge.position.set(hinge.x, hinge.y, 0);
    this.frontHinge.rotation.z = cover.turnSign * Math.PI * open;
    this.frontBoard.position.set(outwardX, 0, 0);

    // Spine: rewritten while the cover moves (or the layout swaps).
    const spineTop = hinge.y + BOARD_T / 2;
    if (Math.abs(spineTop - this.lastSpineHeight) > 1e-5 || this.lastSpineOutward !== outward) {
      updateSpineGeometry(
        this.assets.spineGeometry,
        { outward, yTop: spineTop, open },
        this.lastSpineOutward,
      );
      this.lastSpineHeight = spineTop;
      this.lastSpineOutward = outward;
    }

    // The silk headbands sit at the spine end of the page block, at the head and at the tail, as tall as the block
    // there (down to the valley once the book is open); the ribbon comes out at the tail by the gutter and hangs
    // over the edge onto the table.
    const unturnedTotal = (total - turnedLeaves) * LEAF_T; // the whole unturned block, drawn leaves included
    const blockTop = BASE_Y + unturnedTotal;
    const edgeY = lerp(blockTop, valley + 0.004, open);
    for (const band of this.headbands) {
      const end = band.name === 'headband-head' ? -1 : 1;
      const height = Math.max(edgeY - BASE_Y + 0.004, 0.01);
      band.scale.set(1, height, 1);
      band.position.set(outward * HEADBAND_X, BASE_Y - 0.004 + height / 2, end * (PAGE_H / 2 + 0.012));
    }
    const ribbonOutY = lerp(BASE_Y + unturnedTotal * 0.55, valley + 0.006, open);
    this.ribbon.scale.set(1, Math.max(ribbonOutY - RIBBON_TABLE_Y, 0.01), 1);
    this.ribbon.position.set(outward * RIBBON_X, RIBBON_TABLE_Y, PAGE_H / 2 - 0.01);

    this.warmMesh.visible = this.warmFrames > 0;
    if (this.warmFrames > 0) this.warmFrames -= 1;

    // Hit areas.
    const footprintWidth = PAGE_W + 0.15;
    this.hitBook.position.set(
      (outward * footprintWidth) / 2 - outward * 0.1,
      (BASE_Y + total * LEAF_T) / 2 + 0.02,
      0,
    );
    this.hitBook.scale.set(
      footprintWidth + spineBulge(total),
      BASE_Y + total * LEAF_T + BOARD_T + 0.05,
      PAGE_H + 0.15,
    );
    this.hitBook.visible = open < 0.5;
    this.hitFlyleaf.visible = open > 0.95 && motion.spreadTarget === 0;
    this.hitFlyleaf.position.set((outward * PAGE_W) / 2, unturnedLeafY(0, total) + 0.01, 0);
    this.hitFlyleaf.scale.set(PAGE_W, 0.02, PAGE_H);

    // The root: centred on the middle of the closed book or on the gutter of the open one, hovering, turning over.
    this.hoverMix = damp(this.hoverMix, input.hover, 7, input.dt);
    const yaw = clamp01(motion.yaw.value);
    this.frame.position.x = -outward * closedCenterX(total) * (1 - open);
    this.root.position.y = Math.sin(Math.PI * yaw) * FLIP_LIFT + this.hoverMix * HOVER_LIFT * (1 - open);
    this.root.rotation.y = Math.PI * yaw;
    this.root.rotation.z = Math.sin(Math.PI * yaw) * 0.12 * (outward === 1 ? 1 : -1);
    this.root.rotation.x = -this.hoverMix * 0.017 * (1 - open);

    // Contact shadow: as wide as the book is, fainter while it hovers.
    const closedWidth = closedFootprint(total).width + 0.5;
    const openWidth = openFootprint().width + 0.5;
    this.shadow.scale.set(lerp(closedWidth, openWidth, open), 1, PAGE_H + 2 * BOARD_OVERHANG + 0.55);
    this.shadow.position.x = 0.1;
    this.shadow.position.z = 0.08;
    const lift = this.root.position.y;
    this.assets.shadowMaterial.opacity = this.assets.shadowOpacity * (1 - Math.min(0.55, lift * 1.2));
  }

  private textureFor(source: PageTextureSource | null, face: LeafFace, fallback: Texture): Texture {
    // A diary page is written by the reader: it comes from the diary's own source.
    if (isDiaryFace(face)) return diarySourceRegistry.get()?.getTexture(face) ?? fallback;
    return source?.getTexture(face) ?? fallback;
  }

  private placeStack(
    mesh: Mesh,
    uniforms: StackUniforms,
    height: number,
    side: 1 | -1,
    valley: number,
    turned: 0 | 1,
  ): void {
    mesh.visible = height > 1e-4;
    if (!mesh.visible) return;
    uniforms.uHeight.value = height;
    uniforms.uDrop.value = Math.max(0, BASE_Y + height - valley);
    uniforms.uArch.value = archFor(height);
    uniforms.uStackTurned.value = turned;
    mesh.scale.set(PAGE_W, height, PAGE_H);
    mesh.position.set((side * PAGE_W) / 2, BASE_Y + height / 2, 0);
  }

  dispose(): void {
    this.hitMaterial.dispose();
    this.hitGeometry.dispose();
  }
}
