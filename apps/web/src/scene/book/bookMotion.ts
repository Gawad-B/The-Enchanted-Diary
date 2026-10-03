import { duration, turnTiming } from '../../motion/durations';
import { clamp01, easeInOutCubic } from '../easing';

/*
 * The motion model of the book: plain numbers and tweens, no three.js, no React. The renderer reads the
 * values every frame; presenters (phase sequences, the reader) ask for targets. Every value is an
 * interruptible tween that restarts from wherever it currently is, so a new request in mid-motion never pops.
 *
 *   cover   0 closed .. 1 open
 *   leaves  per leaf, 0 unturned .. 1 turned (leaf 0 is the flyleaf)
 *   yaw     0 .. 1, the closed book turning itself over about the table normal (a half turn at 1)
 */

export interface MotionOptions {
  /** Leaves the current book has. */
  leafCount: number;
  /** Most leaves any book can have (arrays are sized once for it); defaults to `leafCount`. */
  capacity?: number;
  reducedMotion: boolean;
  /** Most leaves allowed in the air at once (the tier's leaf-mesh budget). */
  maxAirborne: number;
}

/** One animated number. Times are seconds on the motion clock. */
export class Track {
  value: number;
  /** Where the value is heading (equals `value` when still). */
  target: number;
  private from: number;
  private start = 0;
  private length = 0;
  active = false;

  constructor(value = 0) {
    this.value = value;
    this.target = value;
    this.from = value;
  }

  /** Tween to `to` over `durationSec`, starting `delaySec` from `now`, from the current value. */
  go(to: number, durationSec: number, delaySec: number, now: number): void {
    this.from = this.value;
    this.target = to;
    this.start = now + delaySec;
    this.length = Math.max(durationSec, 1e-6);
    this.active = this.value !== to;
  }

  /** Jump to `value` at once and stop any tween. */
  snap(value: number): void {
    this.value = value;
    this.target = value;
    this.from = value;
    this.active = false;
  }

  /** True once a delayed tween has begun. */
  started(now: number): boolean {
    return this.active && now >= this.start;
  }

  /** Sign of the motion (+1 towards a larger value, -1 smaller) while it is under way, otherwise 0. */
  velocitySign(now: number): number {
    return this.started(now) ? Math.sign(this.target - this.from) : 0;
  }

  /** Advances to `now`; returns true while still active. */
  update(now: number): boolean {
    if (!this.active) return false;
    if (now < this.start) return true;
    const t = (now - this.start) / this.length;
    if (t >= 1) {
      this.value = this.target;
      this.active = false;
      return false;
    }
    this.value = this.from + (this.target - this.from) * easeInOutCubic(t);
    return true;
  }
}

/** A turned leaf counts as turned from this value on (used to decide which stack it belongs to). */
export const TURNED_THRESHOLD = 0.5;

export class BookMotion {
  readonly cover = new Track(0);
  readonly yaw = new Track(0);
  /** Turned fraction of each leaf, in place (the renderer reads this array directly). */
  readonly thetas: Float32Array;
  /** Direction of each leaf's motion this frame: +1 turning, -1 turning back, 0 still. */
  readonly turnSigns: Int8Array;
  /** Leaves in the current book (at most `capacity`). */
  leafCount: number;
  readonly capacity: number;
  reducedMotion: boolean;
  maxAirborne: number;
  /** Seconds since creation; advances in `update`. */
  clock = 0;
  /** Holds every tween where it is (the development harness freezes a turn to inspect it). */
  frozen = false;

  private readonly leaves: Track[];
  private readonly activeList: Int16Array;
  private activeCount = 0;
  private readonly isListed: Uint8Array;
  /** Spread the leaf targets add up to (leaves whose target is 1). */
  private targetSpread = 0;

  constructor(options: MotionOptions) {
    this.capacity = Math.max(options.capacity ?? options.leafCount, options.leafCount);
    this.leafCount = options.leafCount;
    this.reducedMotion = options.reducedMotion;
    this.maxAirborne = options.maxAirborne;
    this.thetas = new Float32Array(this.capacity);
    this.turnSigns = new Int8Array(this.capacity);
    this.leaves = Array.from({ length: this.capacity }, () => new Track(0));
    this.activeList = new Int16Array(this.capacity);
    this.isListed = new Uint8Array(this.capacity);
  }

  /**
   * A different book (another document): the leaf count changes. Leaves beyond it are put away, and a
   * spread that no longer exists is clamped. Meant for a moment when the book is closed or at rest.
   */
  setLeafCount(count: number): void {
    const next = Math.min(Math.max(Math.round(count), 1), this.capacity);
    if (next === this.leafCount) return;
    this.leafCount = next;
    for (let index = next; index < this.capacity; index += 1) {
      this.leaves[index]?.snap(0);
      this.thetas[index] = 0;
      this.turnSigns[index] = 0;
    }
    if (this.targetSpread > next) this.targetSpread = next;
  }

  private setLeafValue(index: number, value: number): void {
    this.leaves[index]?.snap(value);
    this.thetas[index] = value;
    this.turnSigns[index] = 0;
  }

  /**
   * Binds a leaf into the book at index `at` (global section T: the diary's own pages, before the flyleaf), turned or not. The
   * leaves from there on move up one place with their angles, so for a book at rest nothing that is seen changes; a turned
   * leaf is one more turned leaf of the spread. Refused (false) while a leaf is in the air or the arrays are full.
   */
  insertLeaf(at: number, turned: boolean): boolean {
    if (this.turning || this.leafCount >= this.capacity) return false;
    const index = Math.min(Math.max(Math.round(at), 0), this.leafCount);
    for (let leaf = this.leafCount; leaf > index; leaf -= 1)
      this.setLeafValue(leaf, this.thetas[leaf - 1] ?? 0);
    this.setLeafValue(index, turned ? 1 : 0);
    this.leafCount += 1;
    if (turned) this.targetSpread += 1;
    return true;
  }

  /** The opposite: takes the leaf at `at` out of a book at rest (the oldest diary page, when the diary is full). */
  removeLeaf(at: number): boolean {
    if (this.turning || this.leafCount <= 1) return false;
    const index = Math.min(Math.max(Math.round(at), 0), this.leafCount - 1);
    const turned = (this.thetas[index] ?? 0) >= TURNED_THRESHOLD;
    for (let leaf = index; leaf < this.leafCount - 1; leaf += 1)
      this.setLeafValue(leaf, this.thetas[leaf + 1] ?? 0);
    this.setLeafValue(this.leafCount - 1, 0);
    this.leafCount -= 1;
    if (turned) this.targetSpread = Math.max(this.targetSpread - 1, 0);
    return true;
  }

  /** The spread the leaves are heading for (the settled spread when nothing moves). */
  get spreadTarget(): number {
    return this.targetSpread;
  }

  /** True while anything is tweening, including leaves waiting for their turn in a riffle. */
  get moving(): boolean {
    return this.cover.active || this.yaw.active || this.activeCount > 0;
  }

  /** True while a leaf is turning (used to keep the performance monitor from stepping down mid-turn). */
  get turning(): boolean {
    return this.activeCount > 0;
  }

  get coverOpen(): boolean {
    return this.cover.target >= 0.5;
  }

  private seconds(name: Parameters<typeof duration>[0]): number {
    return duration(name, this.reducedMotion) / 1000;
  }

  /** Swings the cover open or shut from its current angle; returns the time it takes in milliseconds. */
  setCoverOpen(open: boolean): number {
    const to = open ? 1 : 0;
    if (this.cover.target === to && !this.cover.active && this.cover.value === to) return 0;
    const distance = Math.abs(to - this.cover.value);
    const length = this.seconds('coverSwing') * Math.max(0.35, distance);
    this.cover.go(to, length, 0, this.clock);
    return length * 1000;
  }

  private list(index: number): void {
    if (this.isListed[index] === 1) return;
    this.isListed[index] = 1;
    this.activeList[this.activeCount] = index;
    this.activeCount += 1;
  }

  private flyLeaf(index: number, to: 0 | 1, flightSec: number, delaySec: number): void {
    const track = this.leaves[index];
    if (!track) return;
    const distance = Math.abs(to - track.value);
    // A leaf caught part-way only has the rest of the way to go.
    track.go(to, flightSec * Math.max(0.4, distance), delaySec, this.clock);
    if (track.active) this.list(index);
  }

  /**
   * Turns leaves until `spread` leaves are turned. One leaf takes the page-turn duration; more riffle, each
   * overlapping the previous one, within the riffle cap. Returns the total time in milliseconds.
   */
  setSpread(spread: number): number {
    const target = Math.min(Math.max(Math.round(spread), 0), this.leafCount);
    const from = this.targetSpread;
    this.targetSpread = target;
    if (target === from) {
      // Keep any leaf that was caught mid-turn heading the right way.
      this.retargetAll();
      return 0;
    }
    const forward = target > from;
    const count = Math.abs(target - from);
    const timing = turnTiming(count, this.reducedMotion, this.maxAirborne);
    const flight = timing.flightMs / 1000;
    const stagger = timing.staggerMs / 1000;
    const to: 0 | 1 = forward ? 1 : 0;
    for (let k = 0; k < count; k += 1) {
      const index = forward ? from + k : from - 1 - k;
      const isLast = k === count - 1;
      if (this.reducedMotion && !isLast) {
        this.leaves[index]?.snap(to);
        this.thetas[index] = to;
        continue;
      }
      this.flyLeaf(index, to, flight, k * stagger);
    }
    return timing.totalMs;
  }

  private retargetAll(): void {
    for (let index = 0; index < this.leafCount; index += 1) {
      const track = this.leaves[index];
      if (!track) continue;
      const want = index < this.targetSpread ? 1 : 0;
      if (track.target !== want || (!track.active && track.value !== want)) {
        this.flyLeaf(index, want, this.seconds('pageTurn'), 0);
      }
    }
  }

  /** Starts the closed book's half turn about the table normal; returns the time in milliseconds. */
  startFlip(): number {
    const length = this.seconds('directionFlip');
    this.yaw.go(1, length, 0, this.clock);
    return length * 1000;
  }

  /** The flip finished and the layout direction was swapped: the book is back at yaw 0, looking identical. */
  commitFlip(): void {
    this.yaw.snap(0);
  }

  get flipping(): boolean {
    return this.yaw.active;
  }

  get flipDone(): boolean {
    return !this.yaw.active && this.yaw.value >= 1;
  }

  /** Jumps to a pose without animating. */
  snap(pose: { open: boolean; spread: number }): void {
    this.cover.snap(pose.open ? 1 : 0);
    this.yaw.snap(0);
    const spread = pose.open ? Math.min(Math.max(Math.round(pose.spread), 0), this.leafCount) : 0;
    this.targetSpread = spread;
    this.activeCount = 0;
    this.isListed.fill(0);
    for (let index = 0; index < this.capacity; index += 1) {
      const value = index < spread ? 1 : 0;
      this.leaves[index]?.snap(value);
      this.thetas[index] = value;
      this.turnSigns[index] = 0;
    }
  }

  /** Whether leaf `index` has come to rest (not moving and not waiting). */
  leafSettled(index: number): boolean {
    const track = this.leaves[index];
    return !track?.active;
  }

  /** Advances every tween by `dtSeconds`. Allocation-free. */
  update(dtSeconds: number): void {
    if (this.frozen) return;
    this.clock += Math.min(Math.max(dtSeconds, 0), 0.25); // a stalled tab must not skip an animation
    this.cover.update(this.clock);
    this.yaw.update(this.clock);
    let i = 0;
    while (i < this.activeCount) {
      const index = this.activeList[i] ?? 0;
      const track = this.leaves[index];
      if (!track) {
        i += 1;
        continue;
      }
      const stillActive = track.update(this.clock);
      this.thetas[index] = clamp01(track.value);
      this.turnSigns[index] = track.velocitySign(this.clock);
      if (stillActive) {
        i += 1;
      } else {
        this.turnSigns[index] = 0;
        this.isListed[index] = 0;
        this.activeCount -= 1;
        this.activeList[i] = this.activeList[this.activeCount] ?? 0;
      }
    }
  }
}
