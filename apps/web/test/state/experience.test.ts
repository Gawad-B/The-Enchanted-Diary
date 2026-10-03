import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  canAcceptFile,
  createExperienceStore,
  initialExperienceState,
  isTransitional,
  reduce,
  type ExperienceEvent,
  type ExperienceEventType,
  type ExperienceState,
  type Phase,
} from '../../src/state/experience';
import { DOCUMENT_ID, SOME_ERROR, makeDocument, makeFile } from '../fixtures';

const PHASES: Phase[] = [
  'discovery',
  'opening',
  'awaiting',
  'uploading',
  'reading',
  'unveiling',
  'manuscript',
  'revealing',
  'memory',
  'closing',
];

const EVENT_TYPES: ExperienceEventType[] = [
  'SESSION_CHECKED',
  'INTERACT',
  'OPEN_DONE',
  'FILE_SELECTED',
  'UPLOAD_ACCEPTED',
  'UPLOAD_FAILED',
  'INGEST_READY',
  'INGEST_FAILED',
  'UNVEIL_DONE',
  'CANCEL',
  'REPLACE_REQUESTED',
  'REVEAL_TRIGGERED',
  'REVEAL_DONE',
  'MEMORY_DISMISSED',
  'CLOSE_REQUESTED',
  'CLOSE_DONE',
  'DOCUMENT_LOST',
];

const EPOCH = 7;

function stateIn(phase: Phase, patch: Partial<ExperienceState> = {}): ExperienceState {
  return { ...initialExperienceState, phase, epoch: EPOCH, sessionChecked: true, ...patch };
}

/** An event of `type` that is well-formed for `state` (DONE events carry the state's current epoch). */
function eventOf(type: ExperienceEventType, epoch = EPOCH): ExperienceEvent {
  switch (type) {
    case 'SESSION_CHECKED':
      return { type, document: null };
    case 'INTERACT':
    case 'CANCEL':
    case 'REVEAL_TRIGGERED':
    case 'MEMORY_DISMISSED':
    case 'CLOSE_REQUESTED':
      return { type };
    case 'OPEN_DONE':
    case 'UNVEIL_DONE':
    case 'REVEAL_DONE':
    case 'CLOSE_DONE':
      return { type, epoch };
    case 'FILE_SELECTED':
      return { type, file: makeFile() };
    case 'UPLOAD_ACCEPTED':
      return { type, documentId: DOCUMENT_ID };
    case 'UPLOAD_FAILED':
    case 'INGEST_FAILED':
    case 'DOCUMENT_LOST':
      return { type, error: SOME_ERROR };
    case 'INGEST_READY':
      return { type, document: makeDocument() };
    case 'REPLACE_REQUESTED':
      return { type };
  }
}

/** Every valid (phase, event) pair and the phase it leads to. Any pair not listed must be ignored. */
const TRANSITIONS: Partial<Record<Phase, Partial<Record<ExperienceEventType, Phase>>>> = {
  discovery: { INTERACT: 'opening', FILE_SELECTED: 'uploading' },
  opening: { OPEN_DONE: 'awaiting', FILE_SELECTED: 'uploading' },
  awaiting: { FILE_SELECTED: 'uploading', CLOSE_REQUESTED: 'closing' },
  uploading: { UPLOAD_ACCEPTED: 'reading', UPLOAD_FAILED: 'awaiting', CANCEL: 'awaiting' },
  reading: { INGEST_READY: 'unveiling', INGEST_FAILED: 'awaiting', CANCEL: 'awaiting' },
  unveiling: { UNVEIL_DONE: 'manuscript', DOCUMENT_LOST: 'closing' },
  manuscript: {
    REVEAL_TRIGGERED: 'revealing',
    REPLACE_REQUESTED: 'closing',
    CLOSE_REQUESTED: 'closing',
    DOCUMENT_LOST: 'closing',
  },
  revealing: { REVEAL_DONE: 'memory', DOCUMENT_LOST: 'closing' },
  memory: {
    MEMORY_DISMISSED: 'manuscript',
    REPLACE_REQUESTED: 'closing',
    CLOSE_REQUESTED: 'closing',
    DOCUMENT_LOST: 'closing',
  },
  closing: { CLOSE_DONE: 'discovery' },
};

/** Ignored without a warning: the UI shows its own hint, or the event is simply late. */
const SILENT_IGNORES: ReadonlySet<string> = new Set([
  'uploading:FILE_SELECTED',
  'reading:FILE_SELECTED',
  // the check gave up waiting and said "none"; a second answer without a document says nothing new
  'discovery:SESSION_CHECKED',
]);

let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

describe('reduce: every phase against every event', () => {
  const validCount = Object.values(TRANSITIONS).reduce((sum, row) => sum + Object.keys(row).length, 0);

  it('covers the whole matrix', () => {
    expect(PHASES).toHaveLength(10);
    expect(EVENT_TYPES).toHaveLength(17);
    // 25 valid transitions; the other 145 of the 170 (phase, event) pairs must be ignored.
    expect(validCount).toBe(25);
    expect(PHASES.length * EVENT_TYPES.length - validCount).toBe(145);
  });

  for (const phase of PHASES) {
    for (const type of EVENT_TYPES) {
      const target = TRANSITIONS[phase]?.[type];
      if (target) {
        it(`${phase} + ${type} -> ${target} (epoch + 1)`, () => {
          const before = stateIn(phase);
          const after = reduce(before, eventOf(type));
          expect(after.phase).toBe(target);
          expect(after.epoch).toBe(EPOCH + 1);
          expect(warn).not.toHaveBeenCalled();
        });
      } else {
        const silent = SILENT_IGNORES.has(`${phase}:${type}`);
        it(`${phase} + ${type} is ignored${silent ? ' silently' : ' with a warning'}`, () => {
          const before = stateIn(phase);
          const after = reduce(before, eventOf(type));
          expect(after).toBe(before); // the same object: subscribers are not notified
          expect(warn).toHaveBeenCalledTimes(silent ? 0 : 1);
        });
      }
    }
  }
});

describe('session check', () => {
  const unchecked = { ...initialExperienceState };

  it('marks the session checked when there is no document', () => {
    const after = reduce(unchecked, { type: 'SESSION_CHECKED', document: null });
    expect(after).toEqual({ ...initialExperienceState, sessionChecked: true });
    expect(after.epoch).toBe(0);
  });

  it('restores a ready document and stays in discovery', () => {
    const after = reduce(unchecked, { type: 'SESSION_CHECKED', document: makeDocument() });
    expect(after).toMatchObject({
      phase: 'discovery',
      sessionChecked: true,
      restored: true,
      documentId: DOCUMENT_ID,
    });
    expect(after.epoch).toBe(0);
  });

  it('goes straight to reading for a document that is still processing', () => {
    const after = reduce(unchecked, {
      type: 'SESSION_CHECKED',
      document: makeDocument({ status: 'processing', stage: 'embedding' }),
    });
    expect(after).toMatchObject({
      phase: 'reading',
      sessionChecked: true,
      restored: false,
      documentId: DOCUMENT_ID,
    });
    expect(after.epoch).toBe(1);
  });

  it('treats a failed document like no document (the server never sends one)', () => {
    const after = reduce(unchecked, {
      type: 'SESSION_CHECKED',
      document: makeDocument({ status: 'failed', stage: 'failed' }),
    });
    expect(after).toMatchObject({
      phase: 'discovery',
      sessionChecked: true,
      restored: false,
      documentId: null,
    });
  });

  it('a LATE answer (the check gave up waiting and said "none"): a document still restores the book or resumes the reading, while the closed book is untouched', () => {
    const checked = reduce(unchecked, { type: 'SESSION_CHECKED', document: null });
    expect(reduce(checked, { type: 'SESSION_CHECKED', document: null })).toBe(checked); // nothing new: the same object
    expect(reduce(checked, { type: 'SESSION_CHECKED', document: makeDocument() })).toMatchObject({
      phase: 'discovery',
      restored: true,
      documentId: DOCUMENT_ID,
    });
    expect(
      reduce(checked, { type: 'SESSION_CHECKED', document: makeDocument({ status: 'processing' }) }),
    ).toMatchObject({ phase: 'reading', documentId: DOCUMENT_ID });
  });

  it('a late answer is dropped once the book has been touched or already restored one', () => {
    const checked = reduce(unchecked, { type: 'SESSION_CHECKED', document: null });
    const opening = reduce(checked, { type: 'INTERACT' });
    expect(reduce(opening, { type: 'SESSION_CHECKED', document: makeDocument() })).toBe(opening);
    const restored = reduce(unchecked, { type: 'SESSION_CHECKED', document: makeDocument() });
    expect(
      reduce(restored, { type: 'SESSION_CHECKED', document: makeDocument({ id: 'another-document' }) }),
    ).toBe(restored);
  });

  it('ignores a SESSION_CHECKED outside discovery', () => {
    const reading = stateIn('reading');
    expect(
      reduce({ ...reading, sessionChecked: false }, { type: 'SESSION_CHECKED', document: null }),
    ).toMatchObject({
      phase: 'reading',
      sessionChecked: false,
    });
  });

  it('ignores INTERACT and FILE_SELECTED silently until the session is checked', () => {
    expect(reduce(unchecked, { type: 'INTERACT' })).toBe(unchecked);
    expect(reduce(unchecked, { type: 'FILE_SELECTED', file: makeFile() })).toBe(unchecked);
    expect(warn).not.toHaveBeenCalled();
    expect(canAcceptFile(unchecked)).toBe(false);
  });

  it('opens a restored diary by unveiling its pages instead of opening the empty book', () => {
    const restored = reduce(unchecked, { type: 'SESSION_CHECKED', document: makeDocument() });
    const after = reduce(restored, { type: 'INTERACT' });
    expect(after.phase).toBe('unveiling');
    expect(after.documentId).toBe(DOCUMENT_ID);
  });
});

describe('uploading and reading', () => {
  it('keeps the file while uploading and clears a previous error', () => {
    const file = makeFile('a.pdf');
    const after = reduce(stateIn('awaiting', { error: SOME_ERROR }), { type: 'FILE_SELECTED', file });
    expect(after).toMatchObject({ phase: 'uploading', pendingFile: file, error: null });
  });

  it('moves to reading with the new document id and drops the file reference', () => {
    const uploading = stateIn('uploading', { pendingFile: makeFile() });
    const after = reduce(uploading, { type: 'UPLOAD_ACCEPTED', documentId: 'new-id' });
    expect(after).toMatchObject({
      phase: 'reading',
      documentId: 'new-id',
      pendingFile: null,
      restored: false,
    });
  });

  it('returns to awaiting with the error when the upload fails or ingestion fails', () => {
    const failedUpload = reduce(stateIn('uploading', { pendingFile: makeFile() }), {
      type: 'UPLOAD_FAILED',
      error: SOME_ERROR,
    });
    expect(failedUpload).toMatchObject({
      phase: 'awaiting',
      error: SOME_ERROR,
      pendingFile: null,
      documentId: null,
    });
    const failedIngest = reduce(stateIn('reading', { documentId: DOCUMENT_ID }), {
      type: 'INGEST_FAILED',
      error: SOME_ERROR,
    });
    expect(failedIngest).toMatchObject({ phase: 'awaiting', error: SOME_ERROR, documentId: null });
  });

  it('cancels back to awaiting without an error and forgets the document', () => {
    const cancelledUpload = reduce(stateIn('uploading', { pendingFile: makeFile() }), { type: 'CANCEL' });
    expect(cancelledUpload).toMatchObject({ phase: 'awaiting', error: null, pendingFile: null });
    const cancelledReading = reduce(stateIn('reading', { documentId: DOCUMENT_ID }), { type: 'CANCEL' });
    expect(cancelledReading).toMatchObject({ phase: 'awaiting', error: null, documentId: null });
  });

  it('takes the document id from the ready document', () => {
    const after = reduce(stateIn('reading', { documentId: 'old' }), {
      type: 'INGEST_READY',
      document: makeDocument(),
    });
    expect(after).toMatchObject({ phase: 'unveiling', documentId: DOCUMENT_ID });
  });

  it('replaces a restored document: the upload starts from discovery and keeps the old id for the effect to delete', () => {
    const restored = stateIn('discovery', { restored: true, documentId: 'restored-id' });
    const uploading = reduce(restored, { type: 'FILE_SELECTED', file: makeFile() });
    expect(uploading).toMatchObject({ phase: 'uploading', restored: true, documentId: 'restored-id' });
    const reading = reduce(uploading, { type: 'UPLOAD_ACCEPTED', documentId: 'fresh-id' });
    expect(reading).toMatchObject({ phase: 'reading', restored: false, documentId: 'fresh-id' });
    const failed = reduce(uploading, { type: 'UPLOAD_FAILED', error: SOME_ERROR });
    expect(failed).toMatchObject({ phase: 'awaiting', restored: false, documentId: null });
  });
});

describe('closing', () => {
  it('REPLACE_REQUESTED with a file closes toward uploading and keeps the file', () => {
    const file = makeFile();
    const after = reduce(stateIn('manuscript', { documentId: DOCUMENT_ID }), {
      type: 'REPLACE_REQUESTED',
      file,
    });
    expect(after).toMatchObject({ phase: 'closing', afterClose: 'uploading', pendingFile: file });
  });

  it('REPLACE_REQUESTED without a file closes toward opening', () => {
    const after = reduce(stateIn('memory'), { type: 'REPLACE_REQUESTED' });
    expect(after).toMatchObject({ phase: 'closing', afterClose: 'opening', pendingFile: null });
  });

  it('CLOSE_REQUESTED closes toward discovery', () => {
    for (const phase of ['awaiting', 'manuscript', 'memory'] as const) {
      expect(reduce(stateIn(phase), { type: 'CLOSE_REQUESTED' })).toMatchObject({
        phase: 'closing',
        afterClose: 'discovery',
      });
    }
  });

  it('DOCUMENT_LOST closes toward discovery and keeps the error', () => {
    for (const phase of ['unveiling', 'manuscript', 'revealing', 'memory'] as const) {
      const after = reduce(stateIn(phase, { documentId: DOCUMENT_ID }), {
        type: 'DOCUMENT_LOST',
        error: SOME_ERROR,
      });
      expect(after).toMatchObject({ phase: 'closing', afterClose: 'discovery', error: SOME_ERROR });
    }
  });

  it('CLOSE_DONE to discovery clears the document and the file but keeps the error for display', () => {
    const closing = stateIn('closing', {
      afterClose: 'discovery',
      documentId: DOCUMENT_ID,
      restored: true,
      error: SOME_ERROR,
      pendingFile: makeFile(),
    });
    const after = reduce(closing, { type: 'CLOSE_DONE', epoch: EPOCH });
    expect(after).toMatchObject({
      phase: 'discovery',
      documentId: null,
      restored: false,
      pendingFile: null,
      error: SOME_ERROR,
      afterClose: 'discovery',
    });
  });

  it('CLOSE_DONE to opening clears the error', () => {
    const closing = stateIn('closing', { afterClose: 'opening', documentId: DOCUMENT_ID, error: SOME_ERROR });
    const after = reduce(closing, { type: 'CLOSE_DONE', epoch: EPOCH });
    expect(after).toMatchObject({ phase: 'opening', documentId: null, error: null, afterClose: 'discovery' });
  });

  it('CLOSE_DONE to uploading keeps the file that was dropped', () => {
    const file = makeFile();
    const closing = stateIn('closing', {
      afterClose: 'uploading',
      pendingFile: file,
      documentId: DOCUMENT_ID,
    });
    const after = reduce(closing, { type: 'CLOSE_DONE', epoch: EPOCH });
    expect(after).toMatchObject({ phase: 'uploading', pendingFile: file, documentId: null, error: null });
  });

  it('a voluntary close drops a stale error, so the closed book does not announce it again', () => {
    for (const phase of ['awaiting', 'manuscript', 'memory'] as const) {
      const closing = reduce(stateIn(phase, { error: SOME_ERROR }), { type: 'CLOSE_REQUESTED' });
      expect(closing).toMatchObject({ phase: 'closing', error: null });
      const discovery = reduce(closing, { type: 'CLOSE_DONE', epoch: closing.epoch });
      expect(discovery).toMatchObject({ phase: 'discovery', error: null });
    }
    const replacing = reduce(stateIn('manuscript', { error: SOME_ERROR }), { type: 'REPLACE_REQUESTED' });
    expect(replacing.error).toBeNull();
  });

  it('only DOCUMENT_LOST carries an error through closing to discovery', () => {
    const lost = reduce(stateIn('manuscript'), { type: 'DOCUMENT_LOST', error: SOME_ERROR });
    const discovery = reduce(lost, { type: 'CLOSE_DONE', epoch: lost.epoch });
    expect(discovery).toMatchObject({ phase: 'discovery', error: SOME_ERROR });
  });

  it('INTERACT after a lost document clears its error', () => {
    const lost = stateIn('discovery', { error: SOME_ERROR });
    expect(reduce(lost, { type: 'INTERACT' })).toMatchObject({ phase: 'opening', error: null });
  });
});

describe('epochs', () => {
  const doneTypes = ['OPEN_DONE', 'UNVEIL_DONE', 'REVEAL_DONE', 'CLOSE_DONE'] as const;
  const phaseOf = {
    OPEN_DONE: 'opening',
    UNVEIL_DONE: 'unveiling',
    REVEAL_DONE: 'revealing',
    CLOSE_DONE: 'closing',
  } as const;

  for (const type of doneTypes) {
    it(`drops a stale ${type} silently and accepts the current one`, () => {
      const state = stateIn(phaseOf[type]);
      expect(reduce(state, { type, epoch: EPOCH - 1 })).toBe(state);
      expect(reduce(state, { type, epoch: EPOCH + 1 })).toBe(state);
      expect(warn).not.toHaveBeenCalled();
      expect(reduce(state, { type, epoch: EPOCH }).epoch).toBe(EPOCH + 1);
    });
  }

  it('drops a DONE that arrives twice (the watchdog after the presenter)', () => {
    const store = createExperienceStore({ phase: 'opening', epoch: 3, sessionChecked: true });
    store.getState().dispatch({ type: 'OPEN_DONE', epoch: 3 });
    expect(store.getState()).toMatchObject({ phase: 'awaiting', epoch: 4 });
    store.getState().dispatch({ type: 'OPEN_DONE', epoch: 3 });
    expect(store.getState()).toMatchObject({ phase: 'awaiting', epoch: 4 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('increments the epoch on every phase change and never otherwise', () => {
    let state = stateIn('discovery', { epoch: 0, sessionChecked: false });
    const epochs: number[] = [];
    const dispatch = (event: ExperienceEvent): void => {
      state = reduce(state, event);
      epochs.push(state.epoch);
    };
    dispatch({ type: 'SESSION_CHECKED', document: null }); // no phase change
    dispatch({ type: 'INTERACT' });
    dispatch({ type: 'OPEN_DONE', epoch: state.epoch });
    dispatch({ type: 'FILE_SELECTED', file: makeFile() });
    dispatch({ type: 'UPLOAD_ACCEPTED', documentId: DOCUMENT_ID });
    dispatch({ type: 'INGEST_READY', document: makeDocument() });
    expect(epochs).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('helpers', () => {
  it('isTransitional is true for opening, unveiling, revealing and closing only', () => {
    expect(PHASES.filter(isTransitional)).toEqual(['opening', 'unveiling', 'revealing', 'closing']);
  });

  it('canAcceptFile is true in discovery, opening and awaiting once the session is checked', () => {
    expect(PHASES.filter((phase) => canAcceptFile(stateIn(phase)))).toEqual([
      'discovery',
      'opening',
      'awaiting',
    ]);
    expect(canAcceptFile(stateIn('awaiting', { sessionChecked: false }))).toBe(false);
  });
});

describe('the store', () => {
  it('starts in discovery with the session unchecked', () => {
    expect(createExperienceStore().getState()).toMatchObject(initialExperienceState);
  });

  it('notifies subscribers only when the state changes', () => {
    const store = createExperienceStore({ sessionChecked: true });
    const listener = vi.fn();
    store.subscribe(listener);
    store.getState().dispatch({ type: 'CANCEL' }); // invalid in discovery
    expect(listener).not.toHaveBeenCalled();
    store.getState().dispatch({ type: 'INTERACT' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('walks the whole happy path, reading epochs from the store', () => {
    const store = createExperienceStore();
    const { dispatch } = store.getState();
    const phase = (): Phase => store.getState().phase;
    dispatch({ type: 'SESSION_CHECKED', document: null });
    dispatch({ type: 'INTERACT' });
    expect(phase()).toBe('opening');
    dispatch({ type: 'OPEN_DONE', epoch: store.getState().epoch });
    dispatch({ type: 'FILE_SELECTED', file: makeFile() });
    dispatch({ type: 'UPLOAD_ACCEPTED', documentId: DOCUMENT_ID });
    dispatch({ type: 'INGEST_READY', document: makeDocument() });
    dispatch({ type: 'UNVEIL_DONE', epoch: store.getState().epoch });
    expect(phase()).toBe('manuscript');
    dispatch({ type: 'REVEAL_TRIGGERED' });
    dispatch({ type: 'REVEAL_DONE', epoch: store.getState().epoch });
    expect(phase()).toBe('memory');
    dispatch({ type: 'MEMORY_DISMISSED' });
    expect(phase()).toBe('manuscript');
    dispatch({ type: 'CLOSE_REQUESTED' });
    dispatch({ type: 'CLOSE_DONE', epoch: store.getState().epoch });
    expect(store.getState()).toMatchObject({ phase: 'discovery', documentId: null, restored: false });
    expect(warn).not.toHaveBeenCalled();
  });
});
