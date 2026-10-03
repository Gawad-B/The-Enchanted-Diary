import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExperienceShell } from '../../src/components/ExperienceShell';
import { anchorStore } from '../../src/state/anchorStore';
import { closeIntent } from '../../src/state/closeIntent';
import { confirmStore } from '../../src/state/confirmStore';
import { documentStore } from '../../src/state/documentStore';
import { experienceStore, initialExperienceState } from '../../src/state/experience';
import { readerStore } from '../../src/state/readerStore';
import { makeDocument } from '../fixtures';
import { resetStores } from './helpers';

/*
 * The REAL shell with a manuscript open: the confirmation dialog must be modal for the whole stage (reader I-3: the footer
 * bar used to stay bright and clickable above the backdrop), focus must come back to where it was asked from (I-4), and the
 * interface must have no control outside a landmark (m-9: the axe `region` rule was switched off in the isolated tests).
 */

vi.mock('../../src/scene/SceneMount', () => ({
  default: () => <div className="scene-mount" data-testid="scene-mount" />,
}));

// the 3D presenter (its scene stubbed above) is the one that has the reader bar and the upload portal's anchors
const WEBGL_MISSING = () => ({ supported: true });

function openManuscript(direction: 'ltr' | 'rtl' = 'ltr'): void {
  documentStore
    .getState()
    .setDocument(
      makeDocument({ pageCount: 12, direction, primaryLanguage: direction === 'rtl' ? 'ar' : 'en' }),
    );
  readerStore.getState().setDocument(12, direction);
  readerStore.getState().goToSpread(1);
  experienceStore.setState({
    ...initialExperienceState,
    phase: 'manuscript',
    sessionChecked: true,
    documentId: 'x',
  });
}

beforeEach(() => {
  resetStores();
  documentStore.getState().reset();
  readerStore.getState().reset();
  confirmStore.getState().dismiss();
  closeIntent.clear();
  anchorStore.getState().reset();
});

describe('the confirmation dialog is modal for the whole stage', () => {
  it("while a question is up, the stage, its overlay and the footer bar are inert, and the dialog is the root's last child (above the footer)", async () => {
    const user = userEvent.setup();
    openManuscript();
    const { container } = render(<ExperienceShell detectWebGL={WEBGL_MISSING} />);
    const stage = container.querySelector('.stage')!;
    const main = screen.getByRole('main');
    const footer = container.querySelector('.stage__footer')!;
    expect(main).not.toHaveAttribute('inert');
    expect(footer).not.toHaveAttribute('inert');

    await user.click(screen.getByRole('button', { name: 'Diary menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Close this diary' }));

    const dialog = screen.getByRole('alertdialog', { name: 'Close this diary?' });
    expect(main).toHaveAttribute('inert');
    expect(footer).toHaveAttribute('inert'); // the reader bar can neither be clicked nor reached by Tab
    // the dialog is outside both inert subtrees, at the root of the stage, after the footer (so above it: z-modal over z-notice)
    expect(main).not.toContainElement(dialog);
    expect(footer).not.toContainElement(dialog);
    expect(stage.lastElementChild).toContainElement(dialog);
    expect(footer.compareDocumentPosition(dialog) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: 'Not now' }));
    expect(main).not.toHaveAttribute('inert');
    expect(footer).not.toHaveAttribute('inert');
  });

  it('the menu button is inside the inert footer, so a second question ("Start a new session") cannot be asked over the first', async () => {
    const user = userEvent.setup();
    openManuscript();
    render(<ExperienceShell detectWebGL={WEBGL_MISSING} />);
    await user.click(screen.getByRole('button', { name: 'Diary menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Close this diary' }));
    const footer = document.querySelector('.stage__footer')!;
    expect(footer).toHaveAttribute('inert');
    expect(footer).toContainElement(screen.getByRole('button', { name: 'Diary menu', hidden: true }));
    // the only controls a browser lets the reader reach are the dialog's own (jsdom does not apply `inert`: look for it)
    const reachable = screen
      .getAllByRole('button', { hidden: true })
      .filter((button) => button.closest('[inert]') === null);
    expect(reachable.map((button) => button.textContent)).toEqual(['Not now', 'Close the diary']);
  });

  it('I-4: menu -> "Close this diary" -> Escape puts the focus back on the menu button, in the real shell (not on <body>)', async () => {
    const user = userEvent.setup();
    openManuscript();
    render(<ExperienceShell detectWebGL={WEBGL_MISSING} />);
    const menuButton = screen.getByRole('button', { name: 'Diary menu' });
    await user.click(menuButton);
    await user.click(screen.getByRole('menuitem', { name: 'Close this diary' }));
    expect(screen.getByRole('button', { name: 'Not now' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(menuButton).toHaveFocus();
    expect(document.body).not.toHaveFocus();
  });

  it('a question over the manuscript is withdrawn when the manuscript is lost meanwhile (the stage dismisses it with the phase)', async () => {
    const { startConfirmEffect } = await import('../../src/state/effects/confirm');
    const stop = startConfirmEffect();
    openManuscript();
    render(<ExperienceShell detectWebGL={WEBGL_MISSING} />);
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
});

describe('landmarks (m-9): no control outside one, with the axe `region` rule ON, in the real shell', () => {
  async function violations(container: Element) {
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout: contrast is measured in the browser
    });
    return results.violations.map(
      (violation) =>
        `${violation.id}: ${violation.help} (${violation.nodes.map((node) => node.html.slice(0, 90)).join(' | ')})`,
    );
  }

  it.each(['ltr', 'rtl'] as const)(
    'an open %s manuscript with its bar (the quill and the menu) and a dialog is clean',
    async (direction) => {
      const user = userEvent.setup();
      openManuscript(direction);
      const { container } = render(<ExperienceShell detectWebGL={WEBGL_MISSING} />);
      expect(await violations(container)).toEqual([]);
      await user.click(screen.getByRole('button', { name: 'Diary menu' }));
      expect(await violations(container)).toEqual([]);
      await user.click(screen.getByRole('menuitem', { name: 'Close this diary' }));
      expect(await violations(container)).toEqual([]);
    },
  );

  it('the upload portal with an error, and the progress, are inside <main>', async () => {
    experienceStore.setState({
      ...initialExperienceState,
      phase: 'awaiting',
      sessionChecked: true,
      error: { code: 'PDF_ENCRYPTED', message: 'password protected' },
    });
    const { container } = render(<ExperienceShell detectWebGL={WEBGL_MISSING} />);
    expect(screen.getByRole('main')).toContainElement(screen.getByTestId('upload-portal'));
    expect(await violations(container)).toEqual([]);
    act(() => {
      experienceStore.setState({ phase: 'uploading', error: null });
    });
    expect(screen.getByRole('main')).toContainElement(screen.getByTestId('ingest-progress'));
    expect(await violations(container)).toEqual([]);
  });
});

describe('m-3: the focus is never left on the page when a phase takes its control away', () => {
  it('Choose -> uploading: the focus goes to "Withdraw the manuscript"', () => {
    experienceStore.setState({ ...initialExperienceState, phase: 'awaiting', sessionChecked: true });
    render(<ExperienceShell detectWebGL={WEBGL_MISSING} />);
    expect(screen.getByRole('button', { name: 'Offer a manuscript (PDF)' })).toHaveFocus();
    act(() => {
      experienceStore.getState().dispatch({ type: 'FILE_SELECTED', file: new File(['%PDF-1.7'], 'a.pdf') });
    });
    expect(screen.getByRole('button', { name: 'Withdraw the manuscript' })).toHaveFocus();
  });

  it('a resumed reading on page load does NOT take the focus (a stray Space would withdraw the manuscript)', () => {
    experienceStore.setState({
      ...initialExperienceState,
      phase: 'reading',
      sessionChecked: true,
      documentId: 'x',
    });
    render(<ExperienceShell detectWebGL={WEBGL_MISSING} />);
    expect(screen.getByRole('button', { name: 'Withdraw the manuscript' })).not.toHaveFocus();
  });

  it('unveiling -> manuscript: with nothing focused, the focus goes to the stage (the next Tab reaches its first control)', () => {
    openManuscript();
    experienceStore.setState({ phase: 'unveiling', epoch: 5 });
    render(<ExperienceShell detectWebGL={WEBGL_MISSING} />);
    expect(document.body).toHaveFocus();
    act(() => {
      experienceStore.setState({ phase: 'manuscript', epoch: 6 });
    });
    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('a control that has the focus keeps it across a phase change', () => {
    openManuscript();
    render(<ExperienceShell detectWebGL={WEBGL_MISSING} />);
    const keep = screen.getByRole('button', { name: 'Diary menu' });
    keep.focus();
    act(() => {
      experienceStore.setState({ phase: 'memory', epoch: 9 });
    });
    expect(keep).toHaveFocus();
  });
});
