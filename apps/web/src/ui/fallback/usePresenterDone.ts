import { useEffect } from 'react';
import { doneEventFor, experienceStore, useExperienceStore } from '../../state/experience';

/**
 * The simple view's half of the presenter contract (global section F). It has no animation to wait for, so on mount and on every
 * phase change it ends a transitional phase at once, with the epoch the phase started in, and the state machine never stalls.
 * A stale epoch is dropped by the reducer, so a repeated effect (development double mount) is harmless. The simple view has
 * no memory scene either: a memory the reader asked for is dismissed straight away, back to the conversation.
 */
export function usePresenterDone(): void {
  const phase = useExperienceStore((state) => state.phase);
  const epoch = useExperienceStore((state) => state.epoch);
  useEffect(() => {
    const done = doneEventFor(phase, epoch);
    if (done) experienceStore.getState().dispatch(done);
    else if (phase === 'memory') experienceStore.getState().dispatch({ type: 'MEMORY_DISMISSED' });
  }, [phase, epoch]);
}
