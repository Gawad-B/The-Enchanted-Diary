import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExperienceStore, type ExperienceStore, type Phase } from '../../src/state/experience';
import { WATCHDOG_MS, WATCHDOG_REDUCED_MS, startWatchdogs } from '../../src/state/watchdogs';

/** A page whose `hidden` flag the test controls. */
function fakePage() {
  const listeners = new Set<() => void>();
  const page = {
    hidden: false,
    addEventListener: (_type: 'visibilitychange', listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: 'visibilitychange', listener: () => void) => {
      listeners.delete(listener);
    },
  };
  return {
    page,
    setHidden(hidden: boolean) {
      page.hidden = hidden;
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

function setup(options: { reduced?: boolean; phase?: Phase } = {}) {
  const experience = createExperienceStore({ sessionChecked: true, phase: options.phase ?? 'discovery' });
  const reduced = { value: options.reduced ?? false };
  const page = fakePage();
  const stop = startWatchdogs({
    experience,
    settings: { getState: () => ({ reducedMotionResolved: reduced.value }) },
    page: page.page,
  });
  return { experience, page, reduced, stop };
}

function phaseOf(experience: ExperienceStore): Phase {
  return experience.getState().phase;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('limits', () => {
  it('uses 9 s for opening (the long welcome riffle), 9.5 s for unveiling, 4 s for closing and 7 s for revealing; 1.5 s under reduced motion', () => {
    expect(WATCHDOG_MS).toEqual({ opening: 9000, unveiling: 9500, closing: 4000, revealing: 7000 });
    expect(WATCHDOG_REDUCED_MS).toBe(1500);
  });
});

describe('completing a stalled phase', () => {
  it('finishes opening after 9 s', () => {
    const { experience } = setup();
    experience.getState().dispatch({ type: 'SESSION_CHECKED', document: null });
    experience.getState().dispatch({ type: 'INTERACT' });
    expect(phaseOf(experience)).toBe('opening');
    vi.advanceTimersByTime(8999);
    expect(phaseOf(experience)).toBe('opening');
    vi.advanceTimersByTime(1);
    expect(phaseOf(experience)).toBe('awaiting');
  });

  it.each([
    ['unveiling', 9500, 'manuscript'],
    ['revealing', 7000, 'memory'],
    ['closing', 4000, 'discovery'],
  ] as const)('finishes %s after %i ms', (phase, ms, next) => {
    const { experience } = setup({ phase });
    vi.advanceTimersByTime(ms - 1);
    expect(phaseOf(experience)).toBe(phase);
    vi.advanceTimersByTime(1);
    expect(phaseOf(experience)).toBe(next);
  });

  it('arms for a transitional phase the store is already in', () => {
    const { experience } = setup({ phase: 'unveiling' });
    vi.advanceTimersByTime(WATCHDOG_MS.unveiling);
    expect(phaseOf(experience)).toBe('manuscript');
  });

  it('does nothing for phases that are not transitional', () => {
    const { experience } = setup({ phase: 'awaiting' });
    vi.advanceTimersByTime(60_000);
    expect(phaseOf(experience)).toBe('awaiting');
  });

  it('does not fire when the presenter finished first, and the late event is dropped', () => {
    const { experience } = setup({ phase: 'opening' });
    const epoch = experience.getState().epoch;
    vi.advanceTimersByTime(1000);
    experience.getState().dispatch({ type: 'OPEN_DONE', epoch });
    expect(phaseOf(experience)).toBe('awaiting');
    vi.advanceTimersByTime(60_000);
    expect(phaseOf(experience)).toBe('awaiting'); // not "completed" again, not stuck anywhere else
  });

  it('re-arms from scratch for the next transitional phase', () => {
    const { experience } = setup({ phase: 'manuscript' });
    experience.getState().dispatch({ type: 'REVEAL_TRIGGERED' });
    vi.advanceTimersByTime(6999);
    expect(phaseOf(experience)).toBe('revealing');
    vi.advanceTimersByTime(1);
    expect(phaseOf(experience)).toBe('memory');
  });
});

describe('reduced motion', () => {
  it('shortens every limit to 1.5 s', () => {
    for (const phase of ['opening', 'unveiling', 'revealing', 'closing'] as const) {
      const { experience, stop } = setup({ phase, reduced: true });
      vi.advanceTimersByTime(WATCHDOG_REDUCED_MS - 1);
      expect(phaseOf(experience)).toBe(phase);
      vi.advanceTimersByTime(1);
      expect(phaseOf(experience)).not.toBe(phase);
      stop();
    }
  });

  it('reads the preference when the phase starts', () => {
    const { experience, reduced } = setup({ phase: 'manuscript' });
    reduced.value = true;
    experience.getState().dispatch({ type: 'REVEAL_TRIGGERED' });
    vi.advanceTimersByTime(WATCHDOG_REDUCED_MS);
    expect(phaseOf(experience)).toBe('memory');
  });
});

describe('hidden pages', () => {
  it('does not start the timer for a phase that begins while the page is hidden', () => {
    const experience = createExperienceStore({ sessionChecked: true, phase: 'manuscript' });
    const page = fakePage();
    page.page.hidden = true;
    startWatchdogs({
      experience,
      settings: { getState: () => ({ reducedMotionResolved: false }) },
      page: page.page,
    });
    experience.getState().dispatch({ type: 'REVEAL_TRIGGERED' });
    vi.advanceTimersByTime(60_000);
    expect(phaseOf(experience)).toBe('revealing');
    page.setHidden(false);
    vi.advanceTimersByTime(WATCHDOG_MS.revealing - 1);
    expect(phaseOf(experience)).toBe('revealing');
    vi.advanceTimersByTime(1);
    expect(phaseOf(experience)).toBe('memory');
  });

  it('pauses while hidden and resumes with the remaining time', () => {
    const { experience, page } = setup({ phase: 'unveiling' });
    vi.advanceTimersByTime(6000); // 3500 ms left
    page.setHidden(true);
    vi.advanceTimersByTime(120_000);
    expect(phaseOf(experience)).toBe('unveiling');
    page.setHidden(false);
    vi.advanceTimersByTime(3499);
    expect(phaseOf(experience)).toBe('unveiling');
    vi.advanceTimersByTime(1);
    expect(phaseOf(experience)).toBe('manuscript');
  });

  it('can be paused and resumed repeatedly without losing or gaining time', () => {
    const { experience, page } = setup({ phase: 'closing' }); // 4000 ms
    vi.advanceTimersByTime(1000);
    page.setHidden(true);
    vi.advanceTimersByTime(5000);
    page.setHidden(false);
    vi.advanceTimersByTime(1000);
    page.setHidden(true);
    vi.advanceTimersByTime(5000);
    page.setHidden(false);
    vi.advanceTimersByTime(1999);
    expect(phaseOf(experience)).toBe('closing');
    vi.advanceTimersByTime(1);
    expect(phaseOf(experience)).toBe('discovery');
  });
});

describe('stopping', () => {
  it('cancels the pending timer and stops listening', () => {
    const { experience, page, stop } = setup({ phase: 'closing' });
    expect(page.listenerCount()).toBe(1);
    stop();
    expect(page.listenerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(phaseOf(experience)).toBe('closing');
    experience.getState().dispatch({ type: 'CLOSE_DONE', epoch: experience.getState().epoch });
    experience.getState().dispatch({ type: 'INTERACT' });
    vi.advanceTimersByTime(60_000);
    expect(phaseOf(experience)).toBe('opening'); // no watchdog finished it
  });
});
