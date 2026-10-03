import { deleteDocument, forgetBlobOffer, resetSession } from '../../api/documents';
import { closeIntent } from '../closeIntent';
import { documentStore, type DocumentStore } from '../documentStore';
import { experienceStore, type ExperienceStore } from '../experience';
import { pageEffectsStore } from '../pageEffectsStore';
import { pendingReset } from '../pendingReset';

export interface CloseEffectOptions {
  experience?: Pick<ExperienceStore, 'getState' | 'subscribe'>;
  documents?: Pick<DocumentStore, 'getState'>;
  remove?: (documentId: string) => Promise<void>;
  reset?: () => Promise<void>;
  /** Called when the book has closed and the local copies are let go (the conversation store is forgotten by its own effect). */
  onReleased?: () => void;
  /**
   * Called once the server has let the diary go (or after 3 s): starts the experience again from the welcome screen, exactly as
   * a first visit (the owner wants no old closing screens). Default: reload the page. Tests pass a spy.
   */
  restart?: () => void;
}

/**
 * The close side effect. When the diary starts to close from an open manuscript, its document is deleted on the server (or,
 * for "Start a new session", the whole session is reset), except when the document is already gone (DOCUMENT_LOST: a 404
 * must not be answered with a DELETE). When the closing is over the local copies are let go: the document store (which
 * takes the PDF proxy, every page texture and the reader's book with it). The close does not wait for the network: the
 * book closes at once, and a delete that fails is only reported (the document expires by itself); but an upload that
 * follows a "new session" waits for the reset to be over (see state/pendingReset.ts).
 */
export function startCloseEffect(options: CloseEffectOptions = {}): () => void {
  const experience = options.experience ?? experienceStore;
  const documents = options.documents ?? documentStore;
  const remove = options.remove ?? ((id) => deleteDocument(id));
  const reset = options.reset ?? (() => resetSession());
  const onReleased = options.onReleased ?? (() => undefined);
  const restart = options.restart ?? (() => window.location.reload());
  const restartAfter = (work: Promise<unknown>): void => {
    const settled = work.catch(() => undefined);
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3000));
    void Promise.race([settled, timeout]).then(restart);
  };

  return experience.subscribe((state, previous) => {
    if (state.epoch === previous.epoch) return;
    if (state.phase === 'closing') {
      const wantsReset = closeIntent.takeReset();
      // Only DOCUMENT_LOST carries an error into `closing` (a voluntary close clears it): the document is gone already.
      const lost = state.error !== null;
      const id = previous.documentId ?? state.documentId ?? documents.getState().document?.id ?? null;
      if (wantsReset) {
        const resetting = reset();
        // The next offer waits for it (a ticket and a token asked for either side of the reset would belong to two sessions),
        // and a ticket of the old session is worth nothing.
        pendingReset.track(resetting);
        forgetBlobOffer();
        resetting.catch((error: unknown) => {
          console.warn('[close] the session could not be reset', error);
        });
        restartAfter(resetting);
      } else if (id && !lost) {
        const removing = remove(id);
        removing.catch((error: unknown) => {
          console.warn('[close] the document could not be deleted', error);
        });
        restartAfter(removing);
      } else {
        restartAfter(Promise.resolve());
      }
      return;
    }
    // An intent that no closing took (a close the reducer ignored) is not kept for a later, unrelated one.
    closeIntent.clear();
    if (previous.phase === 'closing') {
      // The book is closed. A new upload starts from a clean slate by itself; anything else lets the document go.
      if (state.phase !== 'uploading') documents.getState().reset();
      pageEffectsStore.getState().clearAll();
      onReleased();
    }
  });
}
