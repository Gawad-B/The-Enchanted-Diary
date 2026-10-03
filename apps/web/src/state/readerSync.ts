import { directionForLanguage } from '@enchanted/shared';
import { documentStore, type DocumentStore } from './documentStore';
import { experienceStore, type ExperienceStore } from './experience';
import { readerStore, type ReaderStore } from './readerStore';
import { settingsStore, type SettingsStore } from './settingsStore';

/**
 * Keeps the reader in step with what the application holds: a ready document gives the book its page count
 * and direction; no document means the book reads in the interface's direction; and when the diary unveils
 * the document the reader moves to spread 1 (page 1), so every presenter, the 3D book and the 2D fallback,
 * finds the reader where the manuscript begins. This runs for the life of the page, not with the scene.
 */
export function startReaderSync(
  documents: Pick<DocumentStore, 'getState' | 'subscribe'> = documentStore,
  reader: Pick<ReaderStore, 'getState'> = readerStore,
  settings: Pick<SettingsStore, 'getState' | 'subscribe'> = settingsStore,
  experience: Pick<ExperienceStore, 'getState' | 'subscribe'> = experienceStore,
): () => void {
  const interfaceDirection = () => directionForLanguage(settings.getState().uiLanguage);

  // Unveiling asks for page 1 once. The document may only become the reader's book a moment after the phase
  // changes (or the other way round), so the request waits for both.
  let firstSpreadPending = false;
  const placeFirstSpread = (): void => {
    if (!firstSpreadPending || !reader.getState().hasDocument) return;
    firstSpreadPending = false;
    reader.getState().goToSpread(1);
  };

  const apply = (): void => {
    const { document } = documents.getState();
    if (document?.status === 'ready' && document.pageCount > 0) {
      const state = reader.getState();
      if (
        state.pageCount !== document.pageCount ||
        state.direction !== document.direction ||
        !state.hasDocument
      ) {
        state.setDocument(document.pageCount, document.direction);
      }
    } else if (reader.getState().hasDocument) {
      reader.getState().clearDocument();
      reader.getState().setDirection(interfaceDirection());
    } else if (reader.getState().direction !== interfaceDirection()) {
      reader.getState().setDirection(interfaceDirection());
    }
    placeFirstSpread();
  };

  apply();
  firstSpreadPending = experience.getState().phase === 'unveiling';
  placeFirstSpread();
  const stopExperience = experience.subscribe((state, previous) => {
    if (state.epoch === previous.epoch) return;
    firstSpreadPending = state.phase === 'unveiling';
    placeFirstSpread();
    // A memory is shown on the spread: "Read closely" ends with the manuscript (the camera frames the spread there, and the
    // arrows and the paging must say the same).
    if ((state.phase === 'revealing' || state.phase === 'memory') && reader.getState().closely) {
      reader.getState().setClosely(false);
    }
  });
  const stopDocuments = documents.subscribe((state, previous) => {
    if (state.document !== previous.document) apply();
  });
  const stopSettings = settings.subscribe((state, previous) => {
    if (state.uiLanguage !== previous.uiLanguage) apply();
  });
  return () => {
    stopExperience();
    stopDocuments();
    stopSettings();
  };
}
