import type { Direction } from '@enchanted/shared';
import {
  leadLeavesCount,
  isDiaryFace,
  leafCount as leafCountFor,
  leavesBeforeFlyleaf,
  visibleAndNearFaces,
} from '../../book/bookLayout';
import { diarySourceRegistry } from '../../book/diaryPages';
import { pageSourceRegistry } from '../../book/pageSource';
import { renderGate } from '../../pdf/renderGate';
import { anchorStore } from '../../state/anchorStore';
import { diaryBookStore, MAX_DIARY_LEAVES, sceneBookOf } from '../../state/diaryBook';
import { documentStore } from '../../state/documentStore';
import { experienceStore, type Phase } from '../../state/experience';
import { NO_EFFECTS, pageEffectsStore, type EffectValues } from '../../state/pageEffectsStore';
import { readerStore } from '../../state/readerStore';
import { settingsStore } from '../../state/settingsStore';
import { damp } from '../easing';
import { BookMotion } from './bookMotion';
import type { BookRig, RigInput } from './bookRig';
import { AMBIENT_START, initialPoseFor, midSpread, PhaseRunner, type PresenterEnv } from './phaseRunner';

/**
 * The 3D presenter (global section F): it plays every phase from the book's current pose, ends the
 * transitional ones with an epoch-stamped DONE event, and restarts from the current pose whenever the phase
 * changes. It owns the BookMotion and the BookRig; `frame` is the only place they are advanced. It is a plain
 * class (not a hook) so the frame loop touches no React state.
 */

/** Pages the server accepts at most (MAX_PAGES), so the motion's arrays never have to grow. */
export const MAX_PAGES = 300;

/** Phases whose framing reads the pages: the pages get the reading light. */
const READING_PHASES: ReadonlySet<Phase> = new Set([
  'awaiting',
  'uploading',
  'unveiling',
  'manuscript',
  'revealing',
  'memory',
]);

/**
 * The direction the book should have in a phase: while the diary reads (and as it unveils), the document's once
 * it is ready, else the one the analysis reported (kept by the document store: later progress events carry none),
 * else the interface's. In every other phase it is the reader's.
 */
export function desiredDirection(phase: Phase): Direction {
  const reader = readerStore.getState();
  if (phase === 'reading' || phase === 'unveiling') {
    const { document, reportedDirection } = documentStore.getState();
    if (document?.status === 'ready') return document.direction;
    return reportedDirection ?? reader.direction;
  }
  return reader.direction;
}

export interface BookPresenterOptions {
  rig: BookRig;
  maxAirborne: number;
  reducedMotion: boolean;
}

/** Before a manuscript there are few real leaves; the welcome riffle needs a book thick enough to leaf through. */
export const DECOR_LEAVES = 40;
function withDecor(pageCount: number, count: number): number {
  return pageCount <= 0 ? Math.max(count, DECOR_LEAVES) : count;
}

export class BookPresenter {
  readonly rig: BookRig;
  readonly motion: BookMotion;
  private layout: Direction;
  /** Diary leaves bound into the book now (the diary store's count is what is wanted; a leaf is bound while the book is still). */
  private diaryLeaves = 0; // the diary's own pages bound (the blank lead leaves stand before them: see LEAD_LEAVES)
  private bound = 0; // every leaf bound before the flyleaf: the lead and the diary's
  private runner: PhaseRunner | null = null;
  private readonly smoothed: EffectValues = { ...NO_EFFECTS };
  private readonly frameInput: RigInput;
  private readonly env: PresenterEnv;

  constructor(options: BookPresenterOptions) {
    this.rig = options.rig;
    this.motion = new BookMotion({
      leafCount: leafCountFor(readerStore.getState().pageCount),
      capacity: leafCountFor(MAX_PAGES, MAX_DIARY_LEAVES) + 2,
      reducedMotion: options.reducedMotion,
      maxAirborne: options.maxAirborne,
    });
    this.layout = desiredDirection(experienceStore.getState().phase);
    this.frameInput = {
      motion: this.motion,
      direction: this.layout,
      pageCount: 0,
      hasDocument: false,
      time: 0,
      dt: 0,
      hover: 0,
      reading: false,
      effects: this.smoothed,
      source: pageSourceRegistry.get(),
    };
    this.env = {
      motion: this.motion,
      layoutDirection: () => this.layout,
      setLayoutDirection: (direction) => {
        this.setLayout(direction);
        this.rig.invalidateTextures();
      },
      desiredDirection: () => desiredDirection(experienceStore.getState().phase),
      readerSpread: () => this.sceneSpread(),
      pageTexturesReady: () => {
        const source = pageSourceRegistry.get();
        const { pageCount } = readerStore.getState();
        if (!source) return true;
        // Only the pages that exist are waited for; a source that draws no pages reports parchment as ready.
        return [1, 2].filter((page) => page <= pageCount).every((page) => source.isReady(page));
      },
      cameraSettled: () => anchorStore.getState().stable,
      emit: (event) => {
        experienceStore.getState().dispatch(event);
      },
    };
  }

  /**
   * The number of turned leaves the scene should show: the reader's spread with the diary's leaves turned before it, or the diary
   * page the book is turned to while the reader writes (global section T).
   */
  private sceneSpread(): number {
    const diary = diaryBookStore.getState();
    return sceneBookOf(
      { leaves: this.diaryLeaves, writing: diary.writing, page: diary.page, pdfVisible: diary.pdfVisible },
      readerStore.getState().spread,
    ).spread;
  }

  /**
   * Binds or takes out one diary leaf per frame until the book has as many as the diary wants, and only while it is still (a
   * leaf in the air would be moved under the reader's eyes). The turned leaves are a prefix of the book, so a leaf goes in among
   * them when the reader's pages are turned (it is the first to turn back when the diary is opened, like the front of a book),
   * and after them when the book already stands at the diary: nothing that is seen changes when a leaf is bound.
   */
  private reconcileDiaryLeaves(): void {
    const diary = diaryBookStore.getState();
    const wanted = leavesBeforeFlyleaf(diary.leaves);
    if (this.bound === wanted || this.motion.turning) return;
    const adding = wanted > this.bound;
    // A page of the diary goes in after the diary's others and before the gap that stands between them and the flyleaf.
    const at = (): number => (this.bound === 0 ? 0 : leadLeavesCount() + this.diaryLeaves);
    // The lead leaves and the first page are bound together (one frame), so the book is never seen half way to its diary.
    const steps = adding && this.bound === 0 ? wanted : 1;
    let changed = false;
    for (let step = 0; step < steps; step += 1) {
      const spread = this.motion.spreadTarget;
      const turned = spread > this.bound || (spread === this.bound && !diary.writing);
      const did = adding
        ? this.motion.insertLeaf(at(), turned)
        : this.motion.removeLeaf(leadLeavesCount() + this.diaryLeaves - 1);
      if (!did) break;
      changed = true;
      this.bound += adding ? 1 : -1;
      // The first binding puts in the lead, the diary page and the gap in one go: the diary's pages are what is counted after.
      if (adding && steps > 1)
        this.diaryLeaves = Math.min(diary.leaves, Math.max(0, this.bound - leadLeavesCount()));
      else this.diaryLeaves += adding ? 1 : -1;
    }
    if (!changed) return;

    this.rig.invalidateTextures();
    this.requestFaces();
  }

  /** The direction the book is laid out in now (before `attach`, the one it will start in). */
  get layoutDirection(): Direction {
    return this.layout;
  }

  /** Sets the layout direction at once (a closed book swaps invisibly; the development harness uses it). */
  setLayout(direction: Direction): void {
    this.layout = direction;
    anchorStore.getState().setLayoutDirection(direction);
  }

  private start(phase: Phase, epoch: number): void {
    // A turn-over under way belongs to the phase that began it, which is gone: the new runner finishes it first.
    const inheritedFlip = this.motion.yaw.active || this.motion.yaw.value > 0;
    this.runner = new PhaseRunner(phase, epoch, this.env, { inheritedFlip });
    // The edges glow while the diary reads; real progress takes the value over when it reports.
    if (phase === 'reading') pageEffectsStore.getState().set('progress', { edgeGlow: 0.4 });
    else pageEffectsStore.getState().clear('progress');
  }

  private requestFaces(): void {
    const { pageCount, hasDocument } = readerStore.getState();
    const faces = visibleAndNearFaces(this.sceneSpread(), pageCount, 2, hasDocument, this.diaryLeaves);
    pageSourceRegistry.get()?.request(faces.filter((face) => !isDiaryFace(face)));
    diarySourceRegistry.get()?.request(faces.filter(isDiaryFace));
  }

  /**
   * Mounts: takes the pose the current phase starts from, plays the phase from there, and follows the stores.
   * Returns the function that detaches everything.
   */
  attach(): () => void {
    const { motion, rig } = this;
    motion.reducedMotion = settingsStore.getState().reducedMotionResolved;
    const experience = experienceStore.getState();
    const reader = readerStore.getState();
    this.diaryLeaves = diaryBookStore.getState().leaves;
    this.bound = leavesBeforeFlyleaf(this.diaryLeaves);
    motion.setLeafCount(withDecor(reader.pageCount, leafCountFor(reader.pageCount, this.diaryLeaves)));
    this.setLayout(desiredDirection(experience.phase));
    motion.snap(initialPoseFor(experience.phase, this.sceneSpread()));
    // The upload page lies in the middle of the book.
    if (['awaiting', 'uploading', 'reading', 'unveiling'].includes(experience.phase)) {
      motion.snap({ open: true, spread: midSpread(motion.leafCount) });
    } else if (experience.phase === 'discovery' || experience.phase === 'opening') {
      // The welcome book lies open PAST the flyleaf, on blank pages, and is already leafing.
      motion.snap({ open: true, spread: AMBIENT_START });
    }
    this.start(experience.phase, experience.epoch);

    const stopExperience = experienceStore.subscribe((state, previous) => {
      if (state.epoch !== previous.epoch) this.start(state.phase, state.epoch);
    });
    const stopSettings = settingsStore.subscribe((state) => {
      motion.reducedMotion = state.reducedMotionResolved;
    });
    const stopReader = readerStore.subscribe((state, previous) => {
      if (state.pageCount !== previous.pageCount) {
        const wanted = withDecor(state.pageCount, leafCountFor(state.pageCount, this.diaryLeaves));
        // A document arriving under the open book keeps its leaves (none is added or put away under the reader's eyes).
        motion.setLeafCount(
          previous.pageCount <= 0 && state.pageCount > 0 ? Math.max(wanted, motion.leafCount) : wanted,
        );
      }
      if (state.spread !== previous.spread || state.pageCount !== previous.pageCount) this.requestFaces();
    });
    let stopSource: (() => void) | null = null;
    const attachSource = (): void => {
      stopSource?.();
      const source = pageSourceRegistry.get();
      stopSource = source ? source.subscribe(() => rig.invalidateTextures()) : null;
      rig.invalidateTextures();
      this.requestFaces();
    };
    attachSource();
    const stopRegistry = pageSourceRegistry.subscribe(attachSource);
    // The diary's own pages come from their own source (the pages the reader has written).
    let stopDiarySource: (() => void) | null = null;
    const attachDiarySource = (): void => {
      stopDiarySource?.();
      const source = diarySourceRegistry.get();
      stopDiarySource = source ? source.subscribe(() => rig.invalidateTextures()) : null;
      rig.invalidateTextures();
      this.requestFaces();
    };
    attachDiarySource();
    const stopDiaryRegistry = diarySourceRegistry.subscribe(attachDiarySource);
    const stopDiary = diaryBookStore.subscribe(() => {
      this.requestFaces();
    });

    return () => {
      stopExperience();
      stopSettings();
      stopReader();
      stopRegistry();
      stopSource?.();
      stopDiary();
      stopDiaryRegistry();
      stopDiarySource?.();
      pageEffectsStore.getState().clear('progress');
      renderGate.setBusy(false);
      this.runner = null;
    };
  }

  /** One frame: advance the phase script, the motion, and write the pose into the rig. */
  frame(time: number, delta: number): void {
    this.reconcileDiaryLeaves();
    this.runner?.tick();
    this.motion.update(delta);
    // Page renders wait while anything turns (they cost main-thread time a turn cannot spare).
    renderGate.setBusy(this.motion.moving);
    // The writing surface lies on a diary page only while the book is still.
    diaryBookStore.getState().setMoving(this.motion.moving);
    const reader = readerStore.getState();
    const { phase } = experienceStore.getState();
    const effects = pageEffectsStore.getState();
    // Page effects ease in and out (about 0.6 s) so the glow never switches on or off abruptly.
    const lambda = this.motion.reducedMotion ? 18 : 7.5;
    const smoothed = this.smoothed;
    smoothed.inkSpread = damp(smoothed.inkSpread, effects.values.inkSpread, lambda, delta);
    smoothed.glow = damp(smoothed.glow, effects.values.glow, lambda, delta);
    // No tremble under reduced motion (global section J).
    smoothed.tremble = this.motion.reducedMotion
      ? 0
      : damp(smoothed.tremble, effects.values.tremble, lambda, delta);
    smoothed.edgeGlow = damp(smoothed.edgeGlow, effects.values.edgeGlow, lambda, delta);
    smoothed.memoryPull = damp(smoothed.memoryPull, effects.values.memoryPull, lambda, delta);
    const input = this.frameInput;
    input.direction = this.layout;
    input.pageCount = reader.pageCount;
    input.hasDocument = reader.hasDocument;
    input.diaryLeaves = this.diaryLeaves;
    input.time = time;
    input.dt = delta;
    input.hover = effects.sources.hover.edgeGlow;
    input.reading = READING_PHASES.has(phase);
    input.source = pageSourceRegistry.get();
    this.rig.update(input);
  }

  dispose(): void {
    this.rig.dispose();
  }
}
