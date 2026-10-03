import type { DocumentSummary } from '@enchanted/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api/client';
import { createDocumentStore } from '../../src/state/documentStore';
import { startUploadEffect, toUiError } from '../../src/state/effects/upload';
import {
  createExperienceStore,
  initialExperienceState,
  type ExperienceState,
  type Phase,
} from '../../src/state/experience';
import { createUploadNoticeStore } from '../../src/state/uploadNotice';
import { DOCUMENT_ID, makeDocument, makeFile } from '../fixtures';

const SUMMARY = { id: DOCUMENT_ID } as DocumentSummary;

interface Upload {
  file: File;
  signal: AbortSignal;
  onProgress(progress: { loaded: number; total: number }): void;
  onWaiting(retryAt: number | null): void;
  onDocumentId(id: string): void;
  resolve(summary: DocumentSummary): void;
  reject(error: unknown): void;
}

function setup(phase: Phase = 'awaiting', initial: Partial<ExperienceState> = {}) {
  const experience = createExperienceStore({
    ...initialExperienceState,
    phase,
    sessionChecked: true,
    ...initial,
  });
  const documents = createDocumentStore();
  const notices = createUploadNoticeStore();
  const uploads: Upload[] = [];
  const remove = vi.fn((_id: string) => Promise.resolve());
  const preload = vi.fn();
  let session: { id: string; status: string } | null = null;
  const sessionDocument = vi.fn(() => Promise.resolve(session));
  const stop = startUploadEffect({
    experience,
    documents,
    notices,
    remove,
    preload,
    sessionDocument,
    reapDelaysMs: [0, 0],
    upload: (file, options) =>
      new Promise<DocumentSummary>((resolve, reject) => {
        uploads.push({
          file,
          signal: options.signal!,
          onProgress: (progress) => options.onProgress?.(progress),
          onWaiting: (retryAt) => options.onWaiting?.(retryAt),
          onDocumentId: (id) => options.onDocumentId?.(id),
          resolve,
          reject,
        });
      }),
  });
  return {
    experience,
    documents,
    notices,
    uploads,
    remove,
    preload,
    stop,
    sessionDocument,
    setSession: (next: { id: string; status: string } | null) => {
      session = next;
    },
  };
}

let stopAll: (() => void)[] = [];
beforeEach(() => {
  stopAll = [];
});
afterEach(() => {
  for (const stop of stopAll) stop();
  vi.restoreAllMocks();
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the upload effect', () => {
  it('starts the upload when the file is selected: the file goes into the document store, progress is reported, and the engine code is preloaded', async () => {
    const harness = setup();
    stopAll.push(harness.stop);
    const file = makeFile('manuscript.pdf');
    harness.experience.getState().dispatch({ type: 'FILE_SELECTED', file });
    await flush();
    expect(harness.experience.getState().phase).toBe('uploading');
    expect(harness.uploads).toHaveLength(1);
    expect(harness.uploads[0]?.file).toBe(file);
    expect(harness.documents.getState().file).toBe(file);
    expect(harness.preload).toHaveBeenCalled();
    harness.uploads[0]?.onProgress({ loaded: 4, total: 8 });
    expect(harness.documents.getState().uploadProgress).toEqual({ loaded: 4, total: 8 });
  });

  it('a 202 becomes UPLOAD_ACCEPTED: the diary reads, the progress is cleared', async () => {
    const harness = setup();
    stopAll.push(harness.stop);
    harness.experience.getState().dispatch({ type: 'FILE_SELECTED', file: makeFile() });
    await flush();
    harness.uploads[0]?.resolve(SUMMARY);
    await flush();
    expect(harness.experience.getState()).toMatchObject({
      phase: 'reading',
      documentId: DOCUMENT_ID,
      pendingFile: null,
    });
    expect(harness.documents.getState().uploadProgress).toBeNull();
  });

  it("a refusal becomes UPLOAD_FAILED with the server's code: back to awaiting with the error", async () => {
    const harness = setup();
    stopAll.push(harness.stop);
    harness.experience.getState().dispatch({ type: 'FILE_SELECTED', file: makeFile() });
    await flush();
    harness.uploads[0]?.reject(new ApiError('FILE_TOO_LARGE', 'too big', 413, 'limit'));
    await flush();
    expect(harness.experience.getState()).toMatchObject({
      phase: 'awaiting',
      error: { code: 'FILE_TOO_LARGE', message: 'too big', detail: 'limit' },
    });
    expect(harness.documents.getState().uploadProgress).toBeNull();
  });

  it("an error that is not the server's is INTERNAL with its message (never swallowed)", () => {
    expect(toUiError(new Error('boom'))).toEqual({ code: 'INTERNAL', message: 'boom' });
    expect(toUiError('weird')).toMatchObject({ code: 'INTERNAL' });
  });

  it("withdrawing (CANCEL) aborts the upload and says nothing (an abort is the reader's own choice)", async () => {
    const harness = setup();
    stopAll.push(harness.stop);
    harness.experience.getState().dispatch({ type: 'FILE_SELECTED', file: makeFile() });
    await flush();
    const upload = harness.uploads[0];
    harness.experience.getState().dispatch({ type: 'CANCEL' });
    expect(upload?.signal.aborted).toBe(true);
    expect(harness.experience.getState().phase).toBe('awaiting');
    // what the real uploaders do: reject with an AbortError once aborted
    upload?.reject(new DOMException('cancelled', 'AbortError'));
    await flush();
    expect(harness.experience.getState()).toMatchObject({ phase: 'awaiting', error: null });
    expect(harness.remove).not.toHaveBeenCalled(); // nothing was made that could be deleted
  });

  it('defence in depth: a 202 that still arrives after the withdrawal (a stub, or a future uploader that does not reject) is deleted, never dragged into reading', async () => {
    const harness = setup();
    stopAll.push(harness.stop);
    harness.experience.getState().dispatch({ type: 'FILE_SELECTED', file: makeFile() });
    await flush();
    const upload = harness.uploads[0];
    harness.experience.getState().dispatch({ type: 'CANCEL' });
    upload?.resolve(SUMMARY);
    await flush();
    expect(harness.remove).toHaveBeenCalledWith(DOCUMENT_ID);
    expect(harness.experience.getState().phase).toBe('awaiting');
  });

  it("m-2, Blob mode: once the create may have been sent its id is known (the blob's name), and a withdrawal DELETEs it, though the abort rejects the upload", async () => {
    const harness = setup();
    stopAll.push(harness.stop);
    harness.experience.getState().dispatch({ type: 'FILE_SELECTED', file: makeFile() });
    await flush();
    const upload = harness.uploads[0]!;
    upload.onDocumentId('0a1b2c3d-1111-4222-8333-444455556666');
    harness.experience.getState().dispatch({ type: 'CANCEL' });
    upload.reject(new DOMException('cancelled', 'AbortError')); // the real behaviour
    await flush();
    expect(harness.remove).toHaveBeenCalledWith('0a1b2c3d-1111-4222-8333-444455556666');
  });

  it('m-2, direct mode: a withdrawal after the last byte was sent asks the session whether a document was made all the same, and deletes the one nobody holds', async () => {
    const harness = setup();
    stopAll.push(harness.stop);
    harness.experience.getState().dispatch({ type: 'FILE_SELECTED', file: makeFile() });
    await flush();
    const upload = harness.uploads[0]!;
    upload.onProgress({ loaded: 8, total: 8 }); // everything is on the server's side
    harness.setSession({ id: 'orphan-id', status: 'processing' });
    harness.experience.getState().dispatch({ type: 'CANCEL' });
    upload.reject(new DOMException('cancelled', 'AbortError'));
    await flush();
    expect(harness.sessionDocument).toHaveBeenCalled();
    expect(harness.remove).toHaveBeenCalledWith('orphan-id');
  });

  it('m-2: it does not look (or delete) when the bytes had not all gone, nor delete a document that is not processing', async () => {
    const early = setup();
    stopAll.push(early.stop);
    early.experience.getState().dispatch({ type: 'FILE_SELECTED', file: makeFile() });
    await flush();
    early.uploads[0]!.onProgress({ loaded: 4, total: 8 });
    early.experience.getState().dispatch({ type: 'CANCEL' });
    await flush();
    expect(early.sessionDocument).not.toHaveBeenCalled();

    const late = setup();
    stopAll.push(late.stop);
    late.experience.getState().dispatch({ type: 'FILE_SELECTED', file: makeFile() });
    await flush();
    late.uploads[0]!.onProgress({ loaded: 8, total: 8 });
    late.setSession({ id: 'old-ready', status: 'ready' });
    late.experience.getState().dispatch({ type: 'CANCEL' });
    await flush();
    expect(late.remove).not.toHaveBeenCalled();
  });

  it('a pause the upload takes by itself (the archive is busy) is the same "waiting" note the ingestion shows, and it is cleared when the upload ends', async () => {
    const harness = setup();
    stopAll.push(harness.stop);
    harness.experience.getState().dispatch({ type: 'FILE_SELECTED', file: makeFile() });
    await flush();
    const upload = harness.uploads[0]!;
    upload.onWaiting(1_234_567);
    expect(harness.documents.getState().ingestPause).toEqual({ kind: 'waiting', retryAt: 1_234_567 });
    upload.onWaiting(null);
    expect(harness.documents.getState().ingestPause).toBeNull();
    upload.onWaiting(5);
    upload.reject(new ApiError('RATE_LIMITED', 'busy', 429));
    await flush();
    expect(harness.documents.getState().ingestPause).toBeNull();
    expect(harness.experience.getState().phase).toBe('awaiting');
  });

  it('m-15: the ticket is not asked for until a session reset in flight is over (a ticket and a token under two sessions are refused)', async () => {
    let finishReset: () => void = () => undefined;
    const reset = new Promise<void>((resolve) => {
      finishReset = resolve;
    });
    const experience = createExperienceStore({
      ...initialExperienceState,
      phase: 'awaiting',
      sessionChecked: true,
    });
    const uploads: File[] = [];
    const stop = startUploadEffect({
      experience,
      documents: createDocumentStore(),
      notices: createUploadNoticeStore(),
      remove: () => Promise.resolve(),
      preload: () => undefined,
      resetSettled: () => reset,
      upload: (file) => {
        uploads.push(file);
        return new Promise(() => undefined);
      },
    });
    stopAll.push(stop);
    experience.getState().dispatch({ type: 'FILE_SELECTED', file: makeFile() });
    await flush();
    expect(uploads).toHaveLength(0);
    finishReset();
    await flush();
    expect(uploads).toHaveLength(1);
  });

  it('m-4: stopping the effect aborts the upload in flight (HMR and tests do not leak it)', async () => {
    const harness = setup();
    harness.experience.getState().dispatch({ type: 'FILE_SELECTED', file: makeFile() });
    await flush();
    const upload = harness.uploads[0]!;
    expect(upload.signal.aborted).toBe(false);
    harness.stop();
    expect(upload.signal.aborted).toBe(true);
  });

  it('a replacement dropped on the closed book deletes the restored document first, then uploads', async () => {
    const order: string[] = [];
    const harness = setup('discovery', { restored: true, documentId: DOCUMENT_ID });
    stopAll.push(harness.stop);
    harness.documents.getState().setDocument(makeDocument());
    harness.remove.mockImplementation(() => {
      order.push('delete');
      return Promise.resolve();
    });
    harness.experience.getState().dispatch({ type: 'FILE_SELECTED', file: makeFile() });
    await flush();
    expect(order).toEqual(['delete']);
    expect(harness.remove).toHaveBeenCalledWith(DOCUMENT_ID);
    expect(harness.uploads).toHaveLength(1);
    expect(harness.documents.getState().document).toBeNull(); // the old book is let go
  });

  it('after a closing the close effect has deleted the old document: the upload does not delete it again, and clears what the book held', async () => {
    const harness = setup('manuscript', { documentId: DOCUMENT_ID });
    stopAll.push(harness.stop);
    harness.documents.getState().setDocument(makeDocument());
    const file = makeFile('replacement.pdf');
    harness.experience.getState().dispatch({ type: 'REPLACE_REQUESTED', file });
    harness.experience
      .getState()
      .dispatch({ type: 'CLOSE_DONE', epoch: harness.experience.getState().epoch });
    await flush();
    expect(harness.experience.getState().phase).toBe('uploading');
    expect(harness.remove).not.toHaveBeenCalled();
    expect(harness.uploads[0]?.file).toBe(file);
    expect(harness.documents.getState()).toMatchObject({ document: null, file });
  });

  it('clears the notice of an earlier refused offer when a new upload starts', async () => {
    const harness = setup();
    stopAll.push(harness.stop);
    harness.notices.getState().show({ kind: 'stillReading', fileName: 'x.pdf' });
    harness.experience.getState().dispatch({ type: 'FILE_SELECTED', file: makeFile() });
    await flush();
    expect(harness.notices.getState().notice).toBeNull();
  });
});
