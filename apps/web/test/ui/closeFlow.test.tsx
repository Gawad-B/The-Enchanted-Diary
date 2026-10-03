import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeIntent } from '../../src/state/closeIntent';
import { documentStore } from '../../src/state/documentStore';
import { startCloseEffect } from '../../src/state/effects/close';
import { experienceStore, initialExperienceState } from '../../src/state/experience';
import { readerStore } from '../../src/state/readerStore';
import { confirmStore } from '../../src/state/confirmStore';
import { ConfirmDialogHost } from '../../src/ui/reader/ConfirmDialog';
import { ReaderBar } from '../../src/ui/reader/ReaderBar';
import { UploadPortal } from '../../src/ui/upload/UploadPortal';
import { resetStores } from '../components/helpers';
import { DOCUMENT_ID, makeDocument } from '../fixtures';
import { installFetch } from '../helpers/network';

/*
 * "Close this diary" and "Start a new session" from the reader's menu to the network: the menu asks, the dialog confirms,
 * the book closes at once, the server is asked to forget (DELETE of the document, or the session reset) and the diary is
 * back at discovery with nothing held. The network is replaced at its boundary (fetch).
 */

let stop: () => void;
beforeEach(() => {
  resetStores();
  documentStore.getState().reset();
  readerStore.getState().reset();
  confirmStore.getState().dismiss();
  closeIntent.clear();
  documentStore.getState().setDocument(makeDocument({ pageCount: 12 }));
  readerStore.getState().setDocument(12, 'ltr');
  readerStore.getState().goToSpread(2);
  experienceStore.setState({
    ...initialExperienceState,
    phase: 'manuscript',
    sessionChecked: true,
    documentId: DOCUMENT_ID,
  });
  stop = startCloseEffect({ restart: () => undefined });
});
afterEach(() => {
  stop();
  vi.unstubAllGlobals();
});

function Stage() {
  return (
    <>
      <ReaderBar />
      <UploadPortal />
      <ConfirmDialogHost />
    </>
  );
}

describe('closing the diary from the menu', () => {
  it('asks, then calls DELETE for the document, closes the book and returns to discovery with nothing held', async () => {
    const { calls } = installFetch({
      [`DELETE /api/documents/${DOCUMENT_ID}`]: () => new Response(null, { status: 204 }),
    });
    const user = userEvent.setup();
    render(<Stage />);
    await user.click(screen.getByRole('button', { name: 'Diary menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Close this diary' }));
    expect(calls).toHaveLength(0); // asking changed nothing
    await user.click(screen.getByRole('button', { name: 'Close the diary' }));
    expect(experienceStore.getState().phase).toBe('closing');
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `DELETE /api/documents/${DOCUMENT_ID}`,
    ]);
    act(() => {
      experienceStore.getState().dispatch({ type: 'CLOSE_DONE', epoch: experienceStore.getState().epoch });
    });
    expect(experienceStore.getState().phase).toBe('discovery');
    expect(documentStore.getState().document).toBeNull();
    expect(screen.queryByTestId('reader-bar')).toBeNull();
  });

  it('"Start a new session" resets the session on the server instead', async () => {
    const { calls } = installFetch({ 'POST /api/session/reset': () => new Response(null, { status: 204 }) });
    const user = userEvent.setup();
    render(<Stage />);
    await user.click(screen.getByRole('button', { name: 'Diary menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Start a new session' }));
    await user.click(screen.getByRole('button', { name: 'Start anew' }));
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['POST /api/session/reset']);
    act(() => {
      experienceStore.getState().dispatch({ type: 'CLOSE_DONE', epoch: experienceStore.getState().epoch });
    });
    expect(experienceStore.getState().phase).toBe('discovery');
    expect(documentStore.getState().document).toBeNull();
  });

  it('a document that is gone (404 mid-session) closes the book with the in-world line and calls nothing', async () => {
    const { calls } = installFetch({});
    render(<Stage />);
    act(() => {
      experienceStore.getState().dispatch({
        type: 'DOCUMENT_LOST',
        error: { code: 'DOCUMENT_NOT_FOUND', message: 'The stored file of this document is gone.' },
      });
    });
    act(() => {
      experienceStore.getState().dispatch({ type: 'CLOSE_DONE', epoch: experienceStore.getState().epoch });
    });
    expect(calls).toHaveLength(0);
    expect(experienceStore.getState().phase).toBe('discovery');
    // the closed diary says what happened, in its own voice, with the code
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('I no longer hold that manuscript. Offer it again.');
    expect(alert).toHaveTextContent('DOCUMENT_NOT_FOUND');
  });
});
