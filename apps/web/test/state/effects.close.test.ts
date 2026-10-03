import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetBlobOffer } from '../../src/api/documents';
import { createDocumentStore } from '../../src/state/documentStore';
import { closeIntent } from '../../src/state/closeIntent';
import { startCloseEffect } from '../../src/state/effects/close';
import { createExperienceStore, initialExperienceState, type Phase } from '../../src/state/experience';
import { pendingReset } from '../../src/state/pendingReset';
import { carryOut } from '../../src/state/confirmStore';
import { DOCUMENT_ID, makeDocument, makeFile } from '../fixtures';

function setup(phase: Phase = 'manuscript') {
  const experience = createExperienceStore({
    ...initialExperienceState,
    phase,
    sessionChecked: true,
    documentId: DOCUMENT_ID,
  });
  const documents = createDocumentStore();
  documents.getState().setDocument(makeDocument());
  documents.getState().setFile(makeFile());
  const remove = vi.fn(() => Promise.resolve());
  const reset = vi.fn(() => Promise.resolve());
  const onReleased = vi.fn();
  const stop = startCloseEffect({ experience, documents, remove, reset, onReleased });
  const dispatch = experience.getState().dispatch;
  const finishClosing = (): void => {
    dispatch({ type: 'CLOSE_DONE', epoch: experience.getState().epoch });
  };
  return { experience, documents, remove, reset, onReleased, stop, dispatch, finishClosing };
}

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  closeIntent.clear();
  vi.restoreAllMocks();
});

describe('the close effect', () => {
  it('"Close this diary": DELETEs the document as the book starts to close, without waiting for the network; the local copies go when it has closed', () => {
    const harness = setup();
    stops.push(harness.stop);
    harness.dispatch({ type: 'CLOSE_REQUESTED' });
    expect(harness.remove).toHaveBeenCalledWith(DOCUMENT_ID);
    expect(harness.reset).not.toHaveBeenCalled();
    // still held while the cover swings shut (the leaves riffle back over the pages)
    expect(harness.documents.getState().document).not.toBeNull();
    harness.finishClosing();
    expect(harness.experience.getState().phase).toBe('discovery'); // the book is closed again
    expect(harness.documents.getState().document).toBeNull();
    expect(harness.documents.getState().file).toBeNull();
    expect(harness.onReleased).toHaveBeenCalled();
  });

  it('"Start a new session": resets the session on the server instead of deleting one document', () => {
    const harness = setup();
    stops.push(harness.stop);
    closeIntent.requestReset();
    harness.dispatch({ type: 'CLOSE_REQUESTED' });
    expect(harness.reset).toHaveBeenCalledOnce();
    expect(harness.remove).not.toHaveBeenCalled();
    // the intent is spent: the next close is an ordinary one
    expect(closeIntent.takeReset()).toBe(false);
  });

  it('a document that was lost (a 404 mid-session) is not deleted: nothing to delete', () => {
    const harness = setup();
    stops.push(harness.stop);
    harness.dispatch({ type: 'DOCUMENT_LOST', error: { code: 'DOCUMENT_NOT_FOUND', message: 'gone' } });
    expect(harness.experience.getState()).toMatchObject({ phase: 'closing', afterClose: 'discovery' });
    expect(harness.remove).not.toHaveBeenCalled();
    harness.finishClosing();
    // arrives in discovery with the in-world error to show
    expect(harness.experience.getState()).toMatchObject({
      phase: 'discovery',
      error: { code: 'DOCUMENT_NOT_FOUND' },
    });
    expect(harness.documents.getState().document).toBeNull();
  });

  it('"Offer another manuscript": deletes the old one, and when the book has closed it is let go (the upload that follows starts clean)', () => {
    const harness = setup();
    stops.push(harness.stop);
    harness.dispatch({ type: 'REPLACE_REQUESTED' });
    expect(harness.remove).toHaveBeenCalledWith(DOCUMENT_ID);
    harness.finishClosing();
    expect(harness.experience.getState().phase).toBe('opening');
    expect(harness.documents.getState().document).toBeNull();
  });

  it('a replacement WITH a file keeps the local state for the upload effect to take over (the file is the new one)', () => {
    const harness = setup();
    stops.push(harness.stop);
    const file = makeFile('new.pdf');
    harness.dispatch({ type: 'REPLACE_REQUESTED', file });
    harness.finishClosing();
    expect(harness.experience.getState()).toMatchObject({ phase: 'uploading', pendingFile: file });
    // the close effect leaves the stores alone here: the upload effect resets them itself
    expect(harness.documents.getState().document).not.toBeNull();
  });

  it('closing an empty diary (awaiting) deletes nothing', () => {
    const harness = setup('awaiting');
    stops.push(harness.stop);
    harness.experience.setState({ documentId: null });
    harness.documents.getState().reset();
    harness.dispatch({ type: 'CLOSE_REQUESTED' });
    expect(harness.remove).not.toHaveBeenCalled();
    expect(harness.reset).not.toHaveBeenCalled();
  });

  it('a delete that fails is reported, never thrown: the diary closes anyway', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const harness = setup();
    stops.push(harness.stop);
    harness.remove.mockRejectedValue(new Error('offline'));
    harness.dispatch({ type: 'CLOSE_REQUESTED' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warn).toHaveBeenCalled();
    expect(harness.experience.getState().phase).toBe('closing');
  });

  it('m-3: a "Start a new session" the reducer ignored (the book was turning its pages) does NOT reset the session on a LATER, unrelated closing', () => {
    // through the REAL confirmation path, which sets the intent and dispatches
    const harness = setup('revealing');
    stops.push(harness.stop);
    carryOut({ kind: 'reset' }, harness.experience);
    expect(harness.experience.getState().phase).toBe('revealing'); // CLOSE_REQUESTED is ignored while revealing
    harness.experience.setState({ phase: 'manuscript', epoch: harness.experience.getState().epoch + 1 });
    harness.dispatch({ type: 'CLOSE_REQUESTED' }); // an ordinary close, later
    expect(harness.remove).toHaveBeenCalledWith(DOCUMENT_ID);
    expect(harness.reset).not.toHaveBeenCalled();
  });

  it('m-3: an intent that no closing took is dropped at the next phase change', () => {
    const harness = setup('revealing');
    stops.push(harness.stop);
    closeIntent.requestReset();
    harness.experience.setState({ phase: 'memory', epoch: harness.experience.getState().epoch + 1 });
    harness.dispatch({ type: 'CLOSE_REQUESTED' });
    expect(harness.reset).not.toHaveBeenCalled();
    expect(harness.remove).toHaveBeenCalled();
  });

  it('m-15: a reset in flight is tracked for the next upload, and the ticket of the old session is forgotten', async () => {
    let finish: () => void = () => undefined;
    const harness = setup();
    harness.reset.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    stops.push(harness.stop);
    closeIntent.requestReset();
    harness.dispatch({ type: 'CLOSE_REQUESTED' });
    let settled = false;
    void pendingReset.settled().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false); // the next upload would wait
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(true);
    forgetBlobOffer();
  });

  it('a reset that fails still ends the wait (the upload then tries and gets its own answer)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const harness = setup();
    harness.reset.mockRejectedValue(new Error('offline'));
    stops.push(harness.stop);
    closeIntent.requestReset();
    harness.dispatch({ type: 'CLOSE_REQUESTED' });
    await expect(pendingReset.settled()).resolves.toBeUndefined();
  });
});
