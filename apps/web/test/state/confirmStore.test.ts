import { afterEach, describe, expect, it } from 'vitest';
import { closeIntent } from '../../src/state/closeIntent';
import { carryOut, createConfirmStore } from '../../src/state/confirmStore';
import { startConfirmEffect } from '../../src/state/effects/confirm';
import { createExperienceStore, initialExperienceState } from '../../src/state/experience';
import { makeFile } from '../fixtures';

afterEach(() => {
  closeIntent.clear();
  document.body.replaceChildren();
});

describe('the confirmation store', () => {
  it('counts the questions (each is a new dialog) and remembers what had the focus when it was asked', () => {
    const store = createConfirmStore();
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();
    store.getState().ask({ kind: 'close' });
    expect(store.getState()).toMatchObject({ request: { kind: 'close' }, serial: 1, opener: button });
    store.getState().ask({ kind: 'reset' });
    expect(store.getState().serial).toBe(2);
    store.getState().dismiss();
    expect(store.getState().request).toBeNull();
  });

  it('has no opener when nothing but the page had the focus (a dropped file asks from nowhere)', () => {
    const store = createConfirmStore();
    store.getState().ask({ kind: 'replace', file: makeFile() });
    expect(store.getState().opener).toBeNull();
  });
});

describe('carryOut', () => {
  it('"reset" while the book is turning its pages is ignored by the reducer: the intent is NOT left behind', () => {
    const experience = createExperienceStore({
      ...initialExperienceState,
      phase: 'revealing',
      sessionChecked: true,
    });
    carryOut({ kind: 'reset' }, experience);
    expect(experience.getState().phase).toBe('revealing');
    expect(closeIntent.takeReset()).toBe(false);
  });

  it('"reset" that is accepted leaves its intent for the close effect to take', () => {
    const experience = createExperienceStore({
      ...initialExperienceState,
      phase: 'manuscript',
      sessionChecked: true,
    });
    carryOut({ kind: 'reset' }, experience);
    expect(experience.getState().phase).toBe('closing');
    expect(closeIntent.takeReset()).toBe(true); // (no close effect is running here to take it)
  });
});

describe('the confirm effect: a question belongs to the phase it was asked in', () => {
  it('any change of phase withdraws it', () => {
    const experience = createExperienceStore({
      ...initialExperienceState,
      phase: 'manuscript',
      sessionChecked: true,
    });
    const store = createConfirmStore();
    const stop = startConfirmEffect({ experience, confirm: store });
    store.getState().ask({ kind: 'close' });
    experience.getState().dispatch({ type: 'REVEAL_TRIGGERED' });
    expect(store.getState().request).toBeNull();
    store.getState().ask({ kind: 'close' });
    experience.getState().dispatch({ type: 'CANCEL' }); // ignored in this phase: no change, the question stays
    expect(store.getState().request).not.toBeNull();
    stop();
    experience.getState().dispatch({ type: 'REVEAL_DONE', epoch: experience.getState().epoch });
    expect(store.getState().request).not.toBeNull(); // stopped: it no longer reacts
  });
});
