import type { Object3D } from 'three';
import type { Phase } from '../../state/experience';
import type { BookRig } from './bookRig';

/** What a pointer hit on the book asks for. */
export type BookInteraction = 'open-book' | 'choose-manuscript';

/**
 * What a hit on `object` means in `phase`: the closed diary is the door in discovery, and the flyleaf asks for a
 * manuscript while the diary waits for one. Everything else, in every other phase, is just a picture.
 */
export function interactionFor(
  phase: Phase,
  object: Object3D,
  rig: Pick<BookRig, 'hitBook' | 'hitFlyleaf'>,
): BookInteraction | null {
  if (phase === 'discovery' && object === rig.hitBook) return 'open-book';
  if (phase === 'awaiting' && object === rig.hitFlyleaf) return 'choose-manuscript';
  return null;
}
