import { settingsStore } from '../state/settingsStore';
import { STRINGS } from './strings';

/** The fallback messages of the state effects, in the interface language at the moment they are needed. */
export function fallbackText() {
  return STRINGS[settingsStore.getState().uiLanguage].fallbackErrors;
}
