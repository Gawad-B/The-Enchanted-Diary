import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBookAssets, type BookAssets } from '../../src/scene/book/bookAssets';
import { BookPresenter } from '../../src/scene/book/bookPresenter';
import { BookRig } from '../../src/scene/book/bookRig';
import { anchorStore } from '../../src/state/anchorStore';
import { documentStore } from '../../src/state/documentStore';
import { experienceStore, type Phase } from '../../src/state/experience';
import { pageEffectsStore } from '../../src/state/pageEffectsStore';
import { startReaderSync } from '../../src/state/readerSync';
import { readerStore } from '../../src/state/readerStore';
import { settingsStore } from '../../src/state/settingsStore';
import { resetStores } from '../components/helpers';
import { makeDocument, SOME_ERROR } from '../fixtures';

/*
 * The presenter against the real experience store: it must end each transitional phase with a DONE event the
 * reducer accepts, play from the current pose when the phase changes, and never emit for a stale epoch.
 */

function canvas(width: number, height: number): HTMLCanvasElement {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  return element;
}

let assets: BookAssets;
let presenter: BookPresenter;
let detach: () => void;
let stopSync: () => void;

function mount(): void {
  presenter = new BookPresenter({ rig: new BookRig(assets, 2), maxAirborne: 3, reducedMotion: false });
  detach = presenter.attach();
}

/** Runs frames at 60 fps until `done` or `seconds` pass; returns the seconds it took. */
function runUntil(done: () => boolean, seconds = 12): number {
  let elapsed = 0;
  while (!done() && elapsed < seconds) {
    presenter.frame(elapsed, 1 / 60);
    elapsed += 1 / 60;
  }
  return elapsed;
}

const phase = (): Phase => experienceStore.getState().phase;

function go(next: Phase): void {
  const state = experienceStore.getState();
  experienceStore.setState({ phase: next, epoch: state.epoch + 1, sessionChecked: true });
}

beforeEach(() => {
  resetStores();
  readerStore.getState().reset();
  readerStore.getState().setNarrow(false);
  pageEffectsStore.getState().clearAll();
  documentStore.getState().reset();
  anchorStore.getState().reset();
  // The shared layer runs for the life of the page, with the presenter; so it does here.
  stopSync = startReaderSync();
  assets = createBookAssets('low', canvas, 1);
});

afterEach(() => {
  stopSync();
  detach();
  presenter.dispose();
  assets.dispose();
});

describe('BookPresenter and the experience reducer', () => {
  it('opening ends with OPEN_DONE and the experience reaches awaiting, with the cover open', () => {
    mount();
    go('opening');
    const seconds = runUntil(() => phase() === 'awaiting');
    expect(phase()).toBe('awaiting');
    // the long riffle of the welcome (owner direction T.3b), then the flyleaf
    expect(seconds).toBeGreaterThan(1.2); // (a book with few leaves rushes less)
    expect(seconds).toBeLessThan(8);
    expect(presenter.motion.cover.value).toBe(1);
  });

  it('closing from an open manuscript settles the pages, closes the cover and returns to discovery', () => {
    readerStore.getState().setDocument(40, 'ltr');
    readerStore.getState().goToSpread(5);
    experienceStore.setState({ phase: 'manuscript', epoch: 3, sessionChecked: true });
    mount();
    expect(presenter.motion.cover.value).toBe(1);
    expect(presenter.motion.spreadTarget).toBe(5);
    experienceStore.getState().dispatch({ type: 'CLOSE_REQUESTED' });
    runUntil(() => phase() === 'discovery');
    expect(phase()).toBe('discovery');
    expect(presenter.motion.cover.value).toBe(0);
    expect(presenter.motion.spreadTarget).toBe(0);
  });

  it('unveiling turns the flyleaf and reaches manuscript at spread 1, within the watchdog', () => {
    readerStore.getState().setDocument(40, 'ltr');
    mount();
    go('unveiling');
    const seconds = runUntil(() => phase() === 'manuscript');
    expect(phase()).toBe('manuscript');
    expect(seconds).toBeLessThan(9.5);
    expect(presenter.motion.spreadTarget).toBeGreaterThanOrEqual(1); // (forward only: the welcome's leaves are not turned back)
  });

  it('the manuscript stays on page 1: nothing turns the flyleaf back once it has turned', () => {
    readerStore.getState().setDocument(40, 'ltr');
    mount();
    go('unveiling');
    runUntil(() => phase() === 'manuscript');
    runUntil(() => false, 3);
    expect(phase()).toBe('manuscript');
    expect(readerStore.getState().spread).toBe(1);
    expect(presenter.motion.spreadTarget).toBe(1);
    expect(presenter.motion.thetas[0]).toBe(1);
  });

  it('a document that becomes ready after unveiling began still ends on page 1', () => {
    mount();
    go('unveiling');
    readerStore.getState().setDocument(40, 'ltr');
    documentStore.getState().setDocument(makeDocument({ pageCount: 40 }));
    runUntil(() => phase() === 'manuscript');
    runUntil(() => false, 3);
    expect(readerStore.getState().spread).toBe(1);
    expect(presenter.motion.thetas[0]).toBe(1);
  });

  it('a phase change in the middle of a motion takes over from the current pose (no jump) and never emits the old DONE', () => {
    mount();
    go('opening');
    runUntil(() => presenter.motion.cover.value > 0.4, 5);
    const mid = presenter.motion.cover.value;
    experienceStore.setState({ phase: 'closing', epoch: experienceStore.getState().epoch + 1 });
    presenter.frame(0, 1 / 60);
    expect(Math.abs(presenter.motion.cover.value - mid)).toBeLessThan(0.1);
    runUntil(() => phase() === 'discovery');
    expect(phase()).toBe('discovery');
    expect(experienceStore.getState().afterClose).toBe('discovery');
  });

  it('mounting in a transitional phase plays it from the pose that phase starts with', () => {
    experienceStore.setState({ phase: 'opening', epoch: 7, sessionChecked: true });
    mount();
    expect(presenter.motion.cover.value).toBe(1); // the welcome book lies open already
    runUntil(() => phase() === 'awaiting');
    expect(phase()).toBe('awaiting');
  });

  it('mounting in a resting phase jumps straight to its pose', () => {
    experienceStore.setState({ phase: 'awaiting', epoch: 4, sessionChecked: true });
    mount();
    expect(presenter.motion.cover.value).toBe(1);
    expect(presenter.motion.moving).toBe(false);
  });

  it('a late DONE for an earlier epoch is dropped by the reducer', () => {
    mount();
    go('opening');
    const startedIn = experienceStore.getState().epoch;
    go('discovery');
    experienceStore.getState().dispatch({ type: 'OPEN_DONE', epoch: startedIn });
    expect(phase()).toBe('discovery');
  });

  it('the edges glow while reading and the baseline goes away when reading ends', () => {
    mount();
    go('reading');
    expect(pageEffectsStore.getState().values.edgeGlow).toBeGreaterThan(0.3);
    go('unveiling');
    expect(pageEffectsStore.getState().values.edgeGlow).toBe(0);
  });

  it('the reading light follows the phase, and reduced motion removes the tremble', () => {
    mount();
    settingsStore.setState({ reducedMotionResolved: true });
    pageEffectsStore.getState().set('reveal', { tremble: 1 });
    go('manuscript');
    for (let i = 0; i < 90; i += 1) presenter.frame(i / 60, 1 / 60);
    expect(assets.uniforms.uReading.value).toBeGreaterThan(0.7);
    expect(assets.uniforms.uTremble.value).toBe(0);
    settingsStore.setState({ reducedMotionResolved: false });
    for (let i = 0; i < 90; i += 1) presenter.frame(i / 60, 1 / 60);
    expect(assets.uniforms.uTremble.value).toBeGreaterThan(0.9);
  });

  it('publishes the layout direction the anchors and the camera use', () => {
    readerStore.getState().setDirection('rtl');
    mount();
    expect(presenter.rig.frame.position.x).toBeDefined();
    presenter.setLayout('ltr');
    presenter.frame(0, 1 / 60);
    expect(presenter.rig.root.rotation.y).toBe(0);
  });

  describe('a document that reads from the other side', () => {
    /** Frames until `seconds` of motion clock have passed, the way a mounted scene would. */
    function settle(seconds: number): void {
      runUntil(() => false, seconds);
    }

    function readyRtlDocument(): void {
      documentStore.getState().setDocument(makeDocument({ pageCount: 40, direction: 'rtl' }));
    }

    function runWatchingYaw(done: () => boolean): { maxYaw: number } {
      let maxYaw = 0;
      let elapsed = 0;
      while (!done() && elapsed < 14) {
        presenter.frame(elapsed + 10, 1 / 60);
        maxYaw = Math.max(maxYaw, presenter.motion.yaw.value);
        elapsed += 1 / 60;
      }
      return { maxYaw };
    }

    it('is laid out RTL even when the document is ready while the cover is still closing', () => {
      experienceStore.setState({ phase: 'awaiting', epoch: 4, sessionChecked: true });
      mount();
      settle(2.5);
      go('reading');
      runUntil(() => presenter.motion.cover.value < 0.7, 3);
      expect(presenter.motion.cover.value).toBeGreaterThan(0.2);
      readyRtlDocument();
      go('unveiling');
      const { maxYaw } = runWatchingYaw(() => phase() === 'manuscript');
      expect(phase()).toBe('manuscript');
      expect(anchorStore.getState().layoutDirection).toBe('rtl');
      expect(presenter.rig.root.rotation.y).toBe(0);
      expect(presenter.motion.cover.value).toBe(1);
      // The diary turned itself over once it was closed (it was not a silent swap on an open book).
      expect(maxYaw).toBeGreaterThan(0.9);
    });

    it('closes an open book first when unveiling starts open and the layout is wrong', () => {
      experienceStore.setState({ phase: 'awaiting', epoch: 4, sessionChecked: true });
      mount();
      settle(2.5);
      expect(presenter.motion.cover.value).toBe(1);
      readyRtlDocument();
      go('unveiling');
      let minCover = 1;
      runWatchingYaw(() => {
        minCover = Math.min(minCover, presenter.motion.cover.value);
        return phase() === 'manuscript';
      });
      expect(minCover).toBe(0);
      expect(anchorStore.getState().layoutDirection).toBe('rtl');
    });

    it('an open book that stays open (awaiting) keeps its layout when only the interface changes', () => {
      experienceStore.setState({ phase: 'awaiting', epoch: 4, sessionChecked: true });
      mount();
      settle(2.5);
      readerStore.getState().setDirection('rtl');
      settle(3);
      expect(anchorStore.getState().layoutDirection).toBe('ltr');
      expect(presenter.motion.cover.value).toBe(1);
    });

    it('does not flap while progress events replace each other during reading', () => {
      experienceStore.setState({ phase: 'discovery', epoch: 2, sessionChecked: true });
      mount();
      settle(2.5);
      go('reading');
      const layouts: string[] = [];
      const record = (): void => {
        const layout = anchorStore.getState().layoutDirection;
        if (layouts[layouts.length - 1] !== layout) layouts.push(layout);
      };
      const store = documentStore.getState();
      store.setIngestProgress({
        stage: 'analyzing',
        completed: 1,
        total: 4,
        unit: 'pages',
        direction: 'rtl',
      });
      runWatchingYaw(() => {
        record();
        return presenter.motion.yaw.value === 0 && layouts.includes('rtl');
      });
      for (const stage of ['chunking', 'embedding', 'storing'] as const) {
        store.setIngestProgress({ stage, completed: 1, total: 4, unit: 'chunks' });
        for (let i = 0; i < 240; i += 1) {
          presenter.frame(30 + i / 60, 1 / 60);
          record();
        }
      }
      expect(layouts).toEqual(['ltr', 'rtl']);
    });
  });

  describe('a phase change in the middle of the diary turning itself over', () => {
    function settle(seconds: number): void {
      runUntil(() => false, seconds);
    }

    /** Runs until the flip is under way (the book has turned a fifth of the way round). */
    function untilFlipInFlight(): void {
      runUntil(() => presenter.motion.yaw.active && presenter.motion.yaw.value > 0.2, 6);
      expect(presenter.motion.yaw.value).toBeGreaterThan(0.2);
      expect(presenter.motion.yaw.value).toBeLessThan(0.8);
    }

    function runToRest(ready: () => boolean): void {
      runUntil(() => ready() && !presenter.motion.moving, 14);
    }

    /** The book as it is in the world: the right way up, the layout the scene believes in, nothing half turned. */
    function expectSettled(): void {
      presenter.frame(99, 1 / 60);
      expect(presenter.motion.yaw.value, 'yaw').toBe(0);
      expect(presenter.rig.root.rotation.y, 'rotation').toBe(0);
      expect(presenter.motion.flipping).toBe(false);
    }

    function startReadingRtl(): void {
      experienceStore.setState({ phase: 'discovery', epoch: 2, sessionChecked: true });
      mount();
      settle(2.5);
      go('reading');
      documentStore
        .getState()
        .setIngestProgress({ stage: 'analyzing', completed: 1, total: 4, unit: 'pages', direction: 'rtl' });
      untilFlipInFlight();
    }

    it('INGEST_FAILED mid turn-over: the diary reopens at the flyleaf, the right way up, in the interface direction', () => {
      startReadingRtl();
      experienceStore.getState().dispatch({ type: 'INGEST_FAILED', error: SOME_ERROR });
      expect(phase()).toBe('awaiting');
      runToRest(() => presenter.motion.cover.value === 1);
      expect(presenter.motion.cover.value).toBe(1);
      expectSettled();
      expect(anchorStore.getState().layoutDirection).toBe('ltr');
    });

    it('CANCEL mid turn-over: the same', () => {
      startReadingRtl();
      experienceStore.getState().dispatch({ type: 'CANCEL' });
      expect(phase()).toBe('awaiting');
      runToRest(() => presenter.motion.cover.value === 1);
      expectSettled();
      expect(anchorStore.getState().layoutDirection).toBe('ltr');
    });

    it('DOCUMENT_LOST during the unveiling turn-over, then back to discovery and INTERACT: not left half turned', () => {
      experienceStore.setState({ phase: 'awaiting', epoch: 4, sessionChecked: true });
      mount();
      settle(2.5);
      documentStore.getState().setDocument(makeDocument({ pageCount: 40, direction: 'rtl' }));
      go('unveiling');
      untilFlipInFlight();
      experienceStore.getState().dispatch({ type: 'DOCUMENT_LOST', error: SOME_ERROR });
      documentStore.getState().setDocument(null); // the lost document is gone: the reader is back to the interface
      expect(phase()).toBe('closing');
      runUntil(() => phase() === 'discovery', 14);
      expect(phase()).toBe('discovery');
      runToRest(
        () =>
          presenter.motion.cover.value === 0 &&
          anchorStore.getState().layoutDirection === readerStore.getState().direction,
      );
      expectSettled();
      experienceStore.getState().dispatch({ type: 'INTERACT' });
      runUntil(() => phase() === 'awaiting', 14);
      runToRest(() => presenter.motion.cover.value === 1);
      expectSettled();
      // The layout is whatever direction the reader holds, never the opposite of what the book shows.
      expect(anchorStore.getState().layoutDirection).toBe(readerStore.getState().direction);
    });

    it('INGEST_READY mid turn-over (the same direction): the flip in flight is adopted, not restarted from a standstill', () => {
      startReadingRtl();
      documentStore.getState().setDocument(makeDocument({ pageCount: 40, direction: 'rtl' }));
      const before = presenter.motion.yaw.value;
      go('unveiling');
      // A tenth of a second later the turn-over has carried on at its own speed. A new flip started from here would
      // ease in from a standstill and have barely moved.
      for (let frame = 0; frame < 6; frame += 1) presenter.frame(50 + frame / 60, 1 / 60);
      expect(presenter.motion.yaw.value - before).toBeGreaterThan(0.04);
      runUntil(() => phase() === 'manuscript', 14);
      expect(phase()).toBe('manuscript');
      expect(anchorStore.getState().layoutDirection).toBe('rtl');
      expectSettled();
    });
  });
});
