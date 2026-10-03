import {
  doneEventFor,
  experienceStore,
  isTransitional,
  type ExperienceState,
  type ExperienceStore,
  type Phase,
} from './experience';
import { settingsStore, type SettingsState } from './settingsStore';

/**
 * Safety nets for the transitional phases. The active presenter normally ends a transitional phase by
 * dispatching its DONE event; if it never does (a stalled texture, a lost WebGL context, a crashed effect)
 * the watchdog dispatches the same event so the experience can never hang. The event carries the epoch the
 * phase started in, so a late presenter DONE after the watchdog fired is dropped by the reducer.
 */

/** Longest a transitional phase may run before its watchdog completes it. */
export const WATCHDOG_MS = {
  opening: 9000, // the long welcome riffle (about 6 s) plays inside it
  /** Includes up to 1.5 s of waiting for page textures. */
  unveiling: 9500,
  closing: 4000,
  revealing: 7000,
} as const;

/** Every limit under reduced motion: presenters skip the animation, so the wait is short too. */
export const WATCHDOG_REDUCED_MS = 1500;

type WatchedPhase = keyof typeof WATCHDOG_MS;

function isWatched(phase: Phase): phase is WatchedPhase {
  return isTransitional(phase) && phase in WATCHDOG_MS;
}

/** The part of `document` the watchdogs use. */
export interface VisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface WatchdogDependencies {
  experience: Pick<ExperienceStore, 'getState' | 'subscribe'>;
  settings: { getState(): Pick<SettingsState, 'reducedMotionResolved'> };
  /** The page whose visibility pauses the timers. */
  page: VisibilitySource;
}

interface Armed {
  phase: WatchedPhase;
  epoch: number;
  remainingMs: number;
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Starts the watchdogs for `dependencies` (the app's stores by default) and returns the function that
 * stops them. Timers are paused while the page is hidden: a background tab throttles animation frames, so a
 * presenter cannot finish and the wait should not be charged to it.
 */
export function startWatchdogs(
  dependencies: WatchdogDependencies = {
    experience: experienceStore,
    settings: settingsStore,
    page: document,
  },
): () => void {
  const { experience, settings, page } = dependencies;
  let armed: Armed | null = null;

  const disarm = (): void => {
    if (armed?.timer) clearTimeout(armed.timer);
    armed = null;
  };

  const run = (target: Armed): void => {
    target.startedAt = Date.now();
    target.timer = setTimeout(() => {
      if (armed !== target) return;
      armed = null;
      const event = doneEventFor(target.phase, target.epoch);
      if (event) experience.getState().dispatch(event);
    }, target.remainingMs);
  };

  const arm = (state: ExperienceState): void => {
    disarm();
    if (!isWatched(state.phase)) return;
    const limit = settings.getState().reducedMotionResolved ? WATCHDOG_REDUCED_MS : WATCHDOG_MS[state.phase];
    armed = {
      phase: state.phase,
      epoch: state.epoch,
      remainingMs: limit,
      startedAt: Date.now(),
      timer: null,
    };
    if (!page.hidden) run(armed);
  };

  const onVisibilityChange = (): void => {
    if (!armed) return;
    if (page.hidden) {
      if (armed.timer) {
        clearTimeout(armed.timer);
        armed.timer = null;
        armed.remainingMs = Math.max(0, armed.remainingMs - (Date.now() - armed.startedAt));
      }
    } else if (armed.timer === null) {
      run(armed);
    }
  };

  const unsubscribe = experience.subscribe((state, previous) => {
    if (state.epoch !== previous.epoch) arm(state);
  });
  page.addEventListener('visibilitychange', onVisibilityChange);
  arm(experience.getState()); // the store may already be in a transitional phase

  return () => {
    unsubscribe();
    page.removeEventListener('visibilitychange', onVisibilityChange);
    disarm();
  };
}
