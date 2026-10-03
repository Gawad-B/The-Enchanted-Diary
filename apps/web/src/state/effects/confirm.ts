import { confirmStore, type ConfirmStore } from '../confirmStore';
import { experienceStore, type ExperienceStore } from '../experience';

export interface ConfirmEffectOptions {
  experience?: Pick<ExperienceStore, 'subscribe'>;
  confirm?: Pick<ConfirmStore, 'getState'>;
}

/**
 * A question belongs to the phase it was asked in: "Close this diary?" asked over a manuscript that is lost meanwhile (a
 * 404) or moved on to a memory must not survive into the closed book, where confirming it would silently do something else.
 * Any change of phase withdraws the question.
 */
export function startConfirmEffect(options: ConfirmEffectOptions = {}): () => void {
  const experience = options.experience ?? experienceStore;
  const confirm = options.confirm ?? confirmStore;
  return experience.subscribe((state, previous) => {
    if (state.epoch !== previous.epoch) confirm.getState().dismiss();
  });
}
