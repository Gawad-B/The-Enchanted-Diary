import { experienceStore, initialExperienceState } from '../../src/state/experience';
import { settingsStore } from '../../src/state/settingsStore';

/** Puts the app's singleton stores back to a known state: English, immersive, nothing forced, session checked. */
export function resetStores(): void {
  // Only data is reset; the singleton keeps its own actions.
  settingsStore.setState({
    quality: 'auto',
    resolvedQuality: null,
    sound: false,
    reducedMotion: 'system',
    systemReducedMotion: false,
    reducedMotionResolved: false,
    view: 'immersive',
    uiLanguage: 'en',
    forcedSimple: null,
  });
  experienceStore.setState({ ...initialExperienceState, sessionChecked: true });
}
