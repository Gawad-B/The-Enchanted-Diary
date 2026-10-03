import type { DocumentDetail } from '@enchanted/shared';
import { createStore, useStore, type StoreApi } from 'zustand';
import type { UiError } from '../api/client';

/*
 * The experience state machine: one pure reducer (global section F) plus a zustand store around it. Phases
 * change only through events. Network side effects live in state/effects and only react to phase changes;
 * components and presenters only dispatch.
 */

export type Phase =
  | 'discovery'
  | 'opening'
  | 'awaiting'
  | 'uploading'
  | 'reading'
  | 'unveiling'
  | 'manuscript'
  | 'revealing'
  | 'memory'
  | 'closing';

export type AfterClose = 'discovery' | 'opening' | 'uploading';

export interface ExperienceState {
  phase: Phase;
  /** Increments on EVERY phase change; a DONE event carries the epoch it started in and is dropped if stale. */
  epoch: number;
  error: UiError | null;
  documentId: string | null;
  /** True when the document in this session was restored at boot (discovery shows a book that already holds one). */
  restored: boolean;
  /** False until the boot check of the session's document finished (or timed out). */
  sessionChecked: boolean;
  pendingFile: File | null;
  /** Where `closing` leads. */
  afterClose: AfterClose;
}

export type ExperienceEvent =
  | { type: 'SESSION_CHECKED'; document: DocumentDetail | null }
  | { type: 'INTERACT' }
  | { type: 'OPEN_DONE'; epoch: number }
  | { type: 'FILE_SELECTED'; file: File }
  | { type: 'UPLOAD_ACCEPTED'; documentId: string }
  | { type: 'UPLOAD_FAILED'; error: UiError }
  | { type: 'INGEST_READY'; document: DocumentDetail }
  | { type: 'INGEST_FAILED'; error: UiError }
  | { type: 'UNVEIL_DONE'; epoch: number }
  | { type: 'CANCEL' }
  | { type: 'REPLACE_REQUESTED'; file?: File }
  | { type: 'REVEAL_TRIGGERED' }
  | { type: 'REVEAL_DONE'; epoch: number }
  | { type: 'MEMORY_DISMISSED' }
  | { type: 'CLOSE_REQUESTED' }
  | { type: 'CLOSE_DONE'; epoch: number }
  | { type: 'DOCUMENT_LOST'; error: UiError };

export type ExperienceEventType = ExperienceEvent['type'];

export const initialExperienceState: ExperienceState = {
  phase: 'discovery',
  epoch: 0,
  error: null,
  documentId: null,
  restored: false,
  sessionChecked: false,
  pendingFile: null,
  afterClose: 'discovery',
};

/** Phases that have a presenter animation and end with a DONE event. */
const TRANSITIONAL_PHASES: readonly Phase[] = ['opening', 'unveiling', 'revealing', 'closing'];

export function isTransitional(phase: Phase): boolean {
  return TRANSITIONAL_PHASES.includes(phase);
}

/**
 * The DONE event that ends a transitional phase, stamped with the epoch the phase started in; null for a phase
 * that does not end with one. The presenters and the watchdogs both use it, so there is one definition.
 */
export function doneEventFor(phase: Phase, epoch: number): ExperienceEvent | null {
  switch (phase) {
    case 'opening':
      return { type: 'OPEN_DONE', epoch };
    case 'unveiling':
      return { type: 'UNVEIL_DONE', epoch };
    case 'revealing':
      return { type: 'REVEAL_DONE', epoch };
    case 'closing':
      return { type: 'CLOSE_DONE', epoch };
    default:
      return null;
  }
}

/** Whether a dropped or chosen file starts an upload right now (it does not in manuscript or memory: that asks first). */
export function canAcceptFile(state: ExperienceState): boolean {
  return (
    state.sessionChecked &&
    (state.phase === 'discovery' || state.phase === 'opening' || state.phase === 'awaiting')
  );
}

function go(state: ExperienceState, phase: Phase, patch: Partial<ExperienceState> = {}): ExperienceState {
  return { ...state, ...patch, phase, epoch: state.epoch + 1 };
}

/** An event that does not apply in the current phase: ignored, with a development-only warning. */
function invalid(state: ExperienceState, event: ExperienceEvent): ExperienceState {
  if (import.meta.env.DEV) {
    console.warn(`[experience] ignored ${event.type} in phase "${state.phase}"`);
  }
  return state;
}

/** Epoch-carrying DONE events: stale ones (an earlier phase's presenter or watchdog) are dropped silently. */
function done(
  state: ExperienceState,
  event: ExperienceEvent & { epoch: number },
  phase: Phase,
  next: () => ExperienceState,
): ExperienceState {
  if (event.epoch !== state.epoch) return state;
  return state.phase === phase ? next() : invalid(state, event);
}

/** The reducer. Returns the same object when the event is ignored, so subscribers are not notified. */
export function reduce(state: ExperienceState, event: ExperienceEvent): ExperienceState {
  switch (event.type) {
    case 'SESSION_CHECKED': {
      if (state.phase !== 'discovery') return invalid(state, event);
      // A second answer: the check gave up waiting (a cold server) and the document came after all. Only a document can
      // change anything, and only while the closed book is still all the reader has seen (nothing opened, nothing restored).
      if (state.sessionChecked && (!event.document || state.restored || state.documentId !== null))
        return state;
      const document = event.document;
      if (document?.status === 'processing') {
        return go(state, 'reading', { sessionChecked: true, documentId: document.id, restored: false });
      }
      if (document?.status === 'ready') {
        return { ...state, sessionChecked: true, restored: true, documentId: document.id };
      }
      return { ...state, sessionChecked: true };
    }

    case 'INTERACT':
      if (state.phase !== 'discovery') return invalid(state, event);
      if (!state.sessionChecked) return state; // ignored until the boot check finished
      return state.restored ? go(state, 'unveiling', { error: null }) : go(state, 'opening', { error: null });

    case 'OPEN_DONE':
      return done(state, event, 'opening', () => go(state, 'awaiting'));

    case 'FILE_SELECTED':
      if (state.phase === 'uploading' || state.phase === 'reading') return state; // the UI shows "I am still reading"
      if (state.phase === 'discovery' && !state.sessionChecked) return state;
      if (!canAcceptFile(state)) return invalid(state, event);
      return go(state, 'uploading', { pendingFile: event.file, error: null });

    case 'UPLOAD_ACCEPTED':
      if (state.phase !== 'uploading') return invalid(state, event);
      return go(state, 'reading', { documentId: event.documentId, restored: false, pendingFile: null });

    case 'UPLOAD_FAILED':
      if (state.phase !== 'uploading') return invalid(state, event);
      return go(state, 'awaiting', {
        error: event.error,
        pendingFile: null,
        documentId: null,
        restored: false,
      });

    case 'INGEST_READY':
      if (state.phase !== 'reading') return invalid(state, event);
      return go(state, 'unveiling', { documentId: event.document.id });

    case 'INGEST_FAILED':
      if (state.phase !== 'reading') return invalid(state, event);
      return go(state, 'awaiting', { error: event.error, documentId: null });

    case 'CANCEL':
      if (state.phase !== 'uploading' && state.phase !== 'reading') return invalid(state, event);
      return go(state, 'awaiting', { error: null, pendingFile: null, documentId: null, restored: false });

    case 'UNVEIL_DONE':
      return done(state, event, 'unveiling', () => go(state, 'manuscript'));

    case 'REVEAL_TRIGGERED':
      if (state.phase !== 'manuscript') return invalid(state, event);
      return go(state, 'revealing');

    case 'REVEAL_DONE':
      return done(state, event, 'revealing', () => go(state, 'memory'));

    case 'MEMORY_DISMISSED':
      if (state.phase !== 'memory') return invalid(state, event);
      return go(state, 'manuscript');

    case 'REPLACE_REQUESTED':
      if (state.phase !== 'manuscript' && state.phase !== 'memory') return invalid(state, event);
      return go(state, 'closing', {
        afterClose: event.file ? 'uploading' : 'opening',
        pendingFile: event.file ?? null,
        error: null,
      });

    case 'CLOSE_REQUESTED':
      if (state.phase !== 'awaiting' && state.phase !== 'manuscript' && state.phase !== 'memory') {
        return invalid(state, event);
      }
      // A voluntary close drops any stale error (say, an earlier failed upload) so the closed book does not
      // announce it again; only DOCUMENT_LOST carries an error into closing.
      return go(state, 'closing', { afterClose: 'discovery', error: null });

    case 'DOCUMENT_LOST':
      if (!['manuscript', 'memory', 'revealing', 'unveiling'].includes(state.phase))
        return invalid(state, event);
      return go(state, 'closing', { error: event.error, afterClose: 'discovery' });

    case 'CLOSE_DONE':
      return done(state, event, 'closing', () =>
        go(state, state.afterClose, {
          documentId: null,
          restored: false,
          afterClose: 'discovery',
          // Leaving for a fresh start clears the last error; arriving back at discovery keeps it for display.
          ...(state.afterClose === 'discovery' ? { pendingFile: null } : { error: null }),
        }),
      );
  }
}

export interface ExperienceStoreState extends ExperienceState {
  dispatch(event: ExperienceEvent): void;
}

export type ExperienceStore = StoreApi<ExperienceStoreState>;

export function createExperienceStore(initial: Partial<ExperienceState> = {}): ExperienceStore {
  return createStore<ExperienceStoreState>()((set) => ({
    ...initialExperienceState,
    ...initial,
    dispatch: (event) => {
      set((state) => reduce(state, event));
    },
  }));
}

/** The app's experience state. Components dispatch to it; effects and watchdogs subscribe to it. */
export const experienceStore = createExperienceStore();

export function useExperienceStore<T>(selector: (state: ExperienceStoreState) => T): T {
  return useStore(experienceStore, selector);
}
