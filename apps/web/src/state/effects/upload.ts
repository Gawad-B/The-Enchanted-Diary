import { SessionDocumentResponseSchema, type DocumentSummary } from '@enchanted/shared';
import { ApiError, getJson, isAbortError, type UiError } from '../../api/client';
import { deleteDocument, uploadDocument, type UploadOptions } from '../../api/documents';
import { preloadPdfEngine } from '../../pdf/pdfBook';
import { documentStore, type DocumentStore } from '../documentStore';
import { experienceStore, type ExperienceStore } from '../experience';
import { pendingReset } from '../pendingReset';
import { uploadNoticeStore, type UploadNoticeStore } from '../uploadNotice';

/** When, after a withdrawal, the session is asked whether a document was made all the same (the server may still be committing). */
export const REAP_DELAYS_MS: readonly number[] = [1500, 6000];

export interface UploadEffectOptions {
  experience?: Pick<ExperienceStore, 'getState' | 'subscribe'>;
  documents?: Pick<DocumentStore, 'getState'>;
  notices?: Pick<UploadNoticeStore, 'getState'>;
  upload?: (file: File, options: UploadOptions) => Promise<DocumentSummary>;
  remove?: (documentId: string) => Promise<void>;
  preload?: () => void;
  /** Resolves when a session reset in flight is over (the next ticket must come under the new session). */
  resetSettled?: () => Promise<void>;
  /** The session's current document, for finding one that a withdrawn direct upload made all the same. */
  sessionDocument?: () => Promise<{ id: string; status: string } | null>;
  reapDelaysMs?: readonly number[];
}

/** What a failed offer is told to the reader as: the server's own code and words, or a network failure. */
export function toUiError(error: unknown): UiError {
  if (error instanceof ApiError) return error.toUiError();
  return {
    code: 'INTERNAL',
    message: error instanceof Error ? error.message : 'The manuscript could not be offered',
  };
}

interface Running {
  controller: AbortController;
  epoch: number;
  /** The id the document would have if the server made it (known in Blob mode once the create is on its way). */
  documentId: string | null;
  /** Every byte of a direct upload was sent: the server may be making the document as the reader withdraws. */
  sentAll: boolean;
}

/**
 * The upload side effect (global section F): on entering `uploading` the file in `pendingFile` is sent, with real byte
 * progress (direct multipart by XHR, or straight to the Blob store under a single-use ticket: see api/uploads.ts), and
 * the answer becomes UPLOAD_ACCEPTED or UPLOAD_FAILED. A pause the upload takes by itself (the archive is busy, the
 * connection dropped) is shown as the same "waiting" note the ingestion uses. Leaving `uploading` for anywhere but `reading`
 * (CANCEL) aborts the upload; and the document the server may have made meanwhile is deleted (in Blob mode its id is known;
 * in direct mode the session is asked, a little later, whether a document nobody holds is processing). A document the diary
 * still held (a restored one, replaced by a drop on the closed book) is removed first. Returns the function that stops the
 * effect, and the work in flight with it.
 */
export function startUploadEffect(options: UploadEffectOptions = {}): () => void {
  const experience = options.experience ?? experienceStore;
  const documents = options.documents ?? documentStore;
  const notices = options.notices ?? uploadNoticeStore;
  const upload = options.upload ?? ((file, uploadOptions) => uploadDocument(file, uploadOptions));
  const remove = options.remove ?? ((id) => deleteDocument(id));
  const preload = options.preload ?? preloadPdfEngine;
  const resetSettled = options.resetSettled ?? (() => pendingReset.settled());
  const sessionDocument =
    options.sessionDocument ??
    (async () => (await getJson('/api/session/document', SessionDocumentResponseSchema)).document);
  const reapDelays = options.reapDelaysMs ?? REAP_DELAYS_MS;

  let current: Running | null = null;

  const forget = (id: string): void => {
    remove(id).catch((error: unknown) => {
      console.warn('[upload] a document that was withdrawn could not be deleted', error);
    });
  };

  /** A direct upload withdrawn after its last byte: look, a little later, for a document that was made all the same. */
  const reap = async (): Promise<void> => {
    for (const delay of reapDelays) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      // Another offer began meanwhile: the server's own rule (one document in the making per session) takes care of this one.
      if (current !== null) return;
      try {
        const orphan = await sessionDocument();
        if (orphan?.status === 'processing' && experience.getState().documentId !== orphan.id) {
          forget(orphan.id);
          return;
        }
      } catch {
        // Nothing to find out: the document, if there is one, expires by itself.
      }
    }
  };

  const withdrawn = (running: Running): void => {
    running.controller.abort();
    documents.getState().setUploadProgress(null);
    documents.getState().setIngestPause(null);
    if (running.documentId !== null) forget(running.documentId);
    else if (running.sentAll) void reap();
  };

  const begin = (file: File, epoch: number, fromClosing: boolean): void => {
    const controller = new AbortController();
    const running: Running = { controller, epoch, documentId: null, sentAll: false };
    current = running;
    // After a closing the close effect has asked the server to delete the old document already.
    const stale = fromClosing ? null : documents.getState().document;
    // Whatever the diary held before is let go: this is a new manuscript (the reader's local state, then the server's copy).
    documents.getState().reset();
    documents.getState().setFile(file);
    documents.getState().setUploadProgress({ loaded: 0, total: file.size });
    notices.getState().clear();
    preload();
    const live = (): boolean => current === running && !controller.signal.aborted;

    void (async () => {
      if (stale) {
        try {
          await remove(stale.id);
        } catch (error) {
          // The server also retires a session's other processing documents when a new one arrives; a ready one expires.
          console.warn('[upload] the previous document could not be deleted', error);
        }
      }
      // A session reset in flight (a new session was asked for just before this offer) must finish first.
      await resetSettled();
      if (!live()) return;
      let summary: DocumentSummary;
      try {
        summary = await upload(file, {
          signal: controller.signal,
          onProgress: (progress) => {
            if (!live()) return;
            if (progress.total > 0 && progress.loaded >= progress.total) running.sentAll = true;
            documents.getState().setUploadProgress(progress);
          },
          onWaiting: (retryAt) => {
            if (!live()) return;
            documents.getState().setIngestPause(retryAt === null ? null : { kind: 'waiting', retryAt });
          },
          onDocumentId: (id) => {
            running.documentId = id;
          },
        });
      } catch (error) {
        if (!live() || isAbortError(error)) return;
        documents.getState().setUploadProgress(null);
        documents.getState().setIngestPause(null);
        experience.getState().dispatch({ type: 'UPLOAD_FAILED', error: toUiError(error) });
        return;
      }
      if (!live()) {
        // Withdrawn while the answer was on its way: the server made a document nobody wants.
        forget(summary.id);
        return;
      }
      documents.getState().setUploadProgress(null);
      documents.getState().setIngestPause(null);
      experience.getState().dispatch({ type: 'UPLOAD_ACCEPTED', documentId: summary.id });
    })();
  };

  const unsubscribe = experience.subscribe((state, previous) => {
    if (state.epoch === previous.epoch) return;
    if (state.phase === 'uploading') {
      if (state.pendingFile) begin(state.pendingFile, state.epoch, previous.phase === 'closing');
      return;
    }
    if (current && state.phase !== 'reading') {
      // Out of `uploading` without an accepted upload (withdrawn): stop sending.
      const running = current;
      current = null;
      withdrawn(running);
    } else if (state.phase === 'reading') {
      current = null;
    }
  });

  return () => {
    unsubscribe();
    // Stopping the effect (a hot reload, a test) must not leave an upload running with nobody to hear its end.
    if (current) {
      current.controller.abort();
      current = null;
    }
  };
}
