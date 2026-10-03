import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { anchorStore } from '../../src/state/anchorStore';
import { closeIntent } from '../../src/state/closeIntent';
import { documentStore } from '../../src/state/documentStore';
import { experienceStore, initialExperienceState, type Phase } from '../../src/state/experience';
import { readerStore } from '../../src/state/readerStore';
import { confirmStore } from '../../src/state/confirmStore';
import { startConfirmEffect } from '../../src/state/effects/confirm';
import { ConfirmDialogHost } from '../../src/ui/reader/ConfirmDialog';
import { ReaderBar } from '../../src/ui/reader/ReaderBar';
import { ReaderUi } from '../../src/ui/reader/ReaderUi';
import { makeDocument } from '../fixtures';
import { resetStores } from '../components/helpers';

function open(
  phase: Phase = 'manuscript',
  direction: 'ltr' | 'rtl' = 'ltr',
  pageCount = 40,
  primaryLanguage = 'en',
) {
  documentStore.getState().setDocument(makeDocument({ pageCount, direction, primaryLanguage }));
  readerStore.getState().setDocument(pageCount, direction);
  readerStore.getState().goToSpread(1);
  experienceStore.setState({ ...initialExperienceState, phase, sessionChecked: true, documentId: 'x' });
}

function Both() {
  return (
    <>
      <ReaderUi />
      <ReaderBar />
      <ConfirmDialogHost />
    </>
  );
}

beforeEach(() => {
  resetStores();
  documentStore.getState().reset();
  readerStore.getState().reset();
  confirmStore.getState().dismiss();
  closeIntent.clear();
  anchorStore.getState().reset();
});
afterEach(() => {
  documentStore.getState().reset();
  readerStore.getState().reset();
});

describe('no PDF browsing in the default experience (owner direction T.3d)', () => {
  it('the bar holds only the diary menu (and Task 7\'s quill): no page indicator, "Go to page", "Read closely" or page arrows', () => {
    open();
    render(<Both />);
    expect(screen.getByRole('button', { name: 'Diary menu' })).toBeInTheDocument();
    for (const name of [/go to page/i, /read closely/i, /next page/i, /previous page/i]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.queryByTestId('page-indicator')).toBeNull();
  });

  it('the arrow keys, Home and End do not turn the pages (and Escape has no "Read closely" to leave)', () => {
    open();
    render(<Both />);
    for (const key of ['ArrowRight', 'ArrowLeft', 'End', 'Home', 'PageDown'])
      fireEvent.keyDown(window, { key });
    expect(readerStore.getState().spread).toBe(1);
  });
});

describe('the diary menu and its confirmation', () => {
  it('only ASKS: "Close this diary" opens a dialog, "Not now" closes it and nothing is dispatched', async () => {
    const user = userEvent.setup();
    open();
    render(<Both />);
    await user.click(screen.getByRole('button', { name: 'Diary menu' }));
    const menu = screen.getByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Offer another manuscript', 'Close this diary', 'Start a new session']);
    await user.click(within(menu).getByRole('menuitem', { name: 'Close this diary' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Close this diary?' });
    expect(within(dialog).getByRole('button', { name: 'Not now' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(experienceStore.getState().phase).toBe('manuscript');
    // I-4: the focus is back where the question was asked from (it used to fall to <body>)
    expect(screen.getByRole('button', { name: 'Diary menu' })).toHaveFocus();
  });

  it('confirming "Close this diary" dispatches CLOSE_REQUESTED (the book closes, then discovery)', async () => {
    const user = userEvent.setup();
    open();
    render(<Both />);
    await user.click(screen.getByRole('button', { name: 'Diary menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Close this diary' }));
    await user.click(screen.getByRole('button', { name: 'Close the diary' }));
    expect(experienceStore.getState()).toMatchObject({ phase: 'closing', afterClose: 'discovery' });
    expect(closeIntent.takeReset()).toBe(false);
  });

  it('"Offer another manuscript" closes the diary and reopens it for another (REPLACE_REQUESTED without a file)', async () => {
    const user = userEvent.setup();
    open();
    render(<Both />);
    await user.click(screen.getByRole('button', { name: 'Diary menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Offer another manuscript' }));
    await user.click(screen.getByRole('button', { name: 'Close it and offer another' }));
    expect(experienceStore.getState()).toMatchObject({ phase: 'closing', afterClose: 'opening' });
  });

  it('"Start a new session" closes the diary with the reset intent', async () => {
    const user = userEvent.setup();
    open();
    render(<Both />);
    await user.click(screen.getByRole('button', { name: 'Diary menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Start a new session' }));
    await user.click(screen.getByRole('button', { name: 'Start anew' }));
    expect(experienceStore.getState().phase).toBe('closing');
    expect(closeIntent.takeReset()).toBe(true);
  });

  it('a dropped file over a bound manuscript asks first, naming the file in its own direction (<bdi>), then replaces', async () => {
    const user = userEvent.setup();
    open();
    render(<Both />);
    const file = new File(['%PDF-1.7'], 'تقرير.pdf', { type: 'application/pdf' });
    act(() => {
      confirmStore.getState().ask({ kind: 'replace', file });
    });
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.querySelector('bdi')).toHaveTextContent('تقرير.pdf');
    await user.click(within(dialog).getByRole('button', { name: 'Read it instead' }));
    expect(experienceStore.getState()).toMatchObject({ phase: 'closing', afterClose: 'uploading' });
    expect(experienceStore.getState().pendingFile).toBe(file);
  });

  it('the dialog is a trap: Tab cycles between its two buttons, Escape cancels and the focus goes back', async () => {
    const user = userEvent.setup();
    open();
    render(<Both />);
    const menuButton = screen.getByRole('button', { name: 'Diary menu' });
    await user.click(menuButton);
    await user.click(screen.getByRole('menuitem', { name: 'Close this diary' }));
    const cancel = screen.getByRole('button', { name: 'Not now' });
    const confirm = screen.getByRole('button', { name: 'Close the diary' });
    expect(cancel).toHaveFocus();
    await user.tab();
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(experienceStore.getState().phase).toBe('manuscript');
    // I-4: this is the main reset path; the test used to declare `menuButton` and never look at where the focus went
    expect(menuButton).toHaveFocus();
    expect(document.body).not.toHaveFocus();
  });

  it('a click on the backdrop cancels too, and the focus goes back to the menu button', async () => {
    const user = userEvent.setup();
    open();
    render(<Both />);
    const menuButton = screen.getByRole('button', { name: 'Diary menu' });
    await user.click(menuButton);
    await user.click(screen.getByRole('menuitem', { name: 'Start a new session' }));
    expect(screen.getByRole('alertdialog', { name: 'Start a new session?' })).toBeInTheDocument();
    await user.click(screen.getByTestId('confirm-dialog'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(menuButton).toHaveFocus();
  });

  it('a second question is a new dialog (keyed by its serial): the focus goes to its safe button again', () => {
    open();
    render(<Both />);
    act(() => {
      confirmStore.getState().ask({ kind: 'close' });
    });
    const first = screen.getByTestId('confirm-dialog');
    act(() => {
      confirmStore.getState().ask({ kind: 'reset' });
    });
    expect(screen.getByRole('alertdialog', { name: 'Start a new session?' })).toBeInTheDocument();
    expect(screen.getByTestId('confirm-dialog')).not.toBe(first);
    expect(screen.getByRole('button', { name: 'Not now' })).toHaveFocus();
  });

  it('a question does not outlive the phase it was asked in (the effect dismisses it)', () => {
    open();
    render(<Both />);
    const stop = startConfirmEffect();
    act(() => {
      confirmStore.getState().ask({ kind: 'close' });
    });
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    act(() => {
      experienceStore
        .getState()
        .dispatch({ type: 'DOCUMENT_LOST', error: { code: 'DOCUMENT_NOT_FOUND', message: 'gone' } });
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    stop();
  });

  it('the menu is keyboard operable: arrows move, Escape closes and returns to its button', async () => {
    const user = userEvent.setup();
    open();
    render(<Both />);
    const button = screen.getByRole('button', { name: 'Diary menu' });
    button.focus();
    await user.keyboard('{ArrowDown}');
    const items = screen.getAllByRole('menuitem');
    expect(items[0]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(items[1]).toHaveFocus();
    await user.keyboard('{End}');
    expect(items[2]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(items[0]).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(button).toHaveFocus();
  });
});

describe('when the pages cannot be drawn', () => {
  it("says so, in the diary's voice, with the technical reason", () => {
    open();
    act(() => {
      documentStore
        .getState()
        .setPdfError({ code: 'PDF_UNREADABLE', message: 'InvalidPDFException: bad xref' });
    });
    render(<Both />);
    expect(screen.getByText(/cannot show me its pages/)).toBeInTheDocument();
    expect(screen.getByText('InvalidPDFException: bad xref')).toBeInTheDocument();
  });

  it('S.5/S.15: a stored file the archive will not read again today says "The archive is full for today", not a fault of the browser', () => {
    open();
    act(() => {
      documentStore.getState().setPdfError({
        code: 'RATE_LIMITED',
        message: 'The archive is full for today. Try again tomorrow.',
        detail: 'the archive has used its budget for today',
      });
    });
    render(<Both />);
    expect(
      screen.getByText(/The archive is full for today, so I cannot show you the pages again/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/this browser cannot show me its pages/)).toBeNull();
  });
});
