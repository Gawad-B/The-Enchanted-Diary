import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { anchorStore } from '../../src/state/anchorStore';
import { configStore } from '../../src/state/configStore';
import { documentStore } from '../../src/state/documentStore';
import { experienceStore, initialExperienceState, type Phase } from '../../src/state/experience';
import { pageEffectsStore } from '../../src/state/pageEffectsStore';
import { settingsStore } from '../../src/state/settingsStore';
import { uiRequestStore } from '../../src/state/uiRequests';
import { uploadNoticeStore } from '../../src/state/uploadNotice';
import { Welcome } from '../../src/ui/upload/Welcome';
import { IngestProgress } from '../../src/ui/progress/IngestProgress';
import { confirmStore } from '../../src/state/confirmStore';
import { ConfirmDialogHost } from '../../src/ui/reader/ConfirmDialog';
import { UploadPortal } from '../../src/ui/upload/UploadPortal';
import { resetStores } from '../components/helpers';
import { makeDocument } from '../fixtures';

const config = (over: { freeTierNotice?: boolean; maxUploadBytes?: number } = {}) => ({
  maxUploadBytes: over.maxUploadBytes ?? 20 * 1024 * 1024,
  maxPages: 300,
  acceptedMimeTypes: ['application/pdf'],
  llm: {
    provider: 'gemini',
    model: 'm',
    available: true,
    profile: 'standard' as const,
    ...(over.freeTierNotice ? { freeTierNotice: true } : {}),
  },
  embeddings: { provider: 'gemini', model: 'e' },
  ocr: { provider: 'gemini', available: true },
});

const pdf = (name = 'manuscript.pdf') =>
  new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])], name, { type: 'application/pdf' });
const phase = (): Phase => experienceStore.getState().phase;

function Stage() {
  return (
    <>
      <UploadPortal />
      <IngestProgress />
      <ConfirmDialogHost />
    </>
  );
}

function enter(next: Phase, extra: Partial<ReturnType<typeof experienceStore.getState>> = {}): void {
  experienceStore.setState({ ...initialExperienceState, phase: next, sessionChecked: true, ...extra });
}

/** A drag carrying files (or something else) over the window. */
function drag(
  type: 'dragEnter' | 'dragOver' | 'dragLeave' | 'drop',
  files: File[] = [],
  types: string[] = ['Files'],
) {
  const dataTransfer = { types, files, dropEffect: 'none' };
  const event = new Event(type.toLowerCase(), { bubbles: true, cancelable: true });
  Object.assign(event, { dataTransfer });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  resetStores();
  documentStore.getState().reset();
  uploadNoticeStore.getState().clear();
  configStore.getState().setConfig(null);
  confirmStore.getState().dismiss();
  anchorStore.getState().reset();
  pageEffectsStore.getState().clearAll();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('the upload portal', () => {
  it('awaiting: a real "Choose a manuscript" button that opens the hidden file input; the ONLY control of the page (no sample button)', async () => {
    enter('awaiting');
    const user = userEvent.setup();
    render(<Stage />);
    const button = screen.getByRole('button', { name: 'Offer a manuscript (PDF)' });
    expect(button).toHaveFocus(); // the first thing reached when the cover opens
    const input = screen.getByTestId<HTMLInputElement>('file-input');
    expect(input).toHaveAttribute('accept', 'application/pdf,.pdf');
    expect(input.type).toBe('file');
    const click = vi.spyOn(input, 'click');
    await user.click(button);
    expect(click).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: /sample/i })).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    // the drop alternative is described to a screen reader on the button
    expect(button).toHaveAccessibleDescription(/Drop a PDF manuscript anywhere/);
  });

  it('is not offered in other phases (discovery has the "Open the diary" door; the manuscript has its own controls)', () => {
    for (const other of ['discovery', 'uploading', 'reading', 'manuscript'] as const) {
      enter(other);
      const { unmount } = render(<Stage />);
      expect(screen.queryByRole('button', { name: 'Offer a manuscript (PDF)' }), other).toBeNull();
      unmount();
    }
  });

  it('a chosen file starts the upload: FILE_SELECTED, awaiting -> uploading', async () => {
    enter('awaiting');
    render(<Stage />);
    const file = pdf();
    fireEvent.change(screen.getByTestId('file-input'), { target: { files: [file] } });
    await waitFor(() => {
      expect(phase()).toBe('uploading');
    });
    expect(experienceStore.getState().pendingFile).toBe(file);
  });

  it('the flyleaf, clicked in the scene, asks for the same picker, but only while the diary waits', () => {
    enter('awaiting');
    render(<Stage />);
    const click = vi.spyOn(screen.getByTestId<HTMLInputElement>('file-input'), 'click');
    act(() => {
      uiRequestStore.getState().request('choose-manuscript');
    });
    expect(click).toHaveBeenCalledOnce();
    act(() => {
      enter('manuscript');
    });
    act(() => {
      uiRequestStore.getState().request('choose-manuscript');
    });
    expect(click).toHaveBeenCalledOnce();
  });

  it("refuses a file the browser can tell is wrong, in the diary's voice with the code, and the phase does not change", async () => {
    enter('awaiting');
    render(<Stage />);
    fireEvent.change(screen.getByTestId('file-input'), {
      target: { files: [new File(['hello'], 'notes.txt', { type: 'text/plain' })] },
    });
    const alert = await screen.findByRole('alert');
    // the line names the real reason (the name), not a generic "not a PDF"
    expect(alert).toHaveTextContent('That file does not end in .pdf. Offer a PDF manuscript.');
    expect(alert).toHaveTextContent('FILE_NOT_PDF');
    expect(phase()).toBe('awaiting');
  });

  it('a .pdf the browser does not take for a PDF (its type) and one that does not begin like a PDF (its first bytes) each say so', async () => {
    enter('awaiting');
    render(<Stage />);
    fireEvent.change(screen.getByTestId('file-input'), {
      target: { files: [new File(['%PDF-1.7'], 'sheet.pdf', { type: 'text/plain' })] },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This browser does not take that file for a PDF. Offer a PDF manuscript.',
    );
    fireEvent.change(screen.getByTestId('file-input'), {
      target: { files: [new File(['hello there'], 'renamed.pdf', { type: 'application/pdf' })] },
    });
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'That file ends in .pdf but does not begin like a PDF; it may have been renamed.',
      );
    });
  });

  it('a renamed text file (wrong magic bytes) is refused before any upload', async () => {
    enter('awaiting');
    render(<Stage />);
    fireEvent.change(screen.getByTestId('file-input'), {
      target: { files: [new File(['not a pdf at all'], 'fake.pdf', { type: 'application/pdf' })] },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('FILE_NOT_PDF');
    expect(phase()).toBe('awaiting');
  });

  it('an oversized file is refused with the server\'s limit written in ("Offer a file under 1 MB")', async () => {
    configStore.getState().setConfig(config({ maxUploadBytes: 1024 * 1024 }));
    enter('awaiting');
    render(<Stage />);
    const big = new File([new Uint8Array(1024 * 1024 + 1)], 'big.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByTestId('file-input'), { target: { files: [big] } });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This file exceeds the maximum size. Offer a file under 1 MB.',
    );
  });

  it('shows the in-world error of a failed upload or reading, with the technical code under it', () => {
    enter('awaiting', {
      error: { code: 'PDF_ENCRYPTED', message: 'The PDF is password protected.', detail: 'encrypted' },
    });
    render(<Stage />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('The document is password protected.');
    expect(alert).toHaveTextContent('PDF_ENCRYPTED · The PDF is password protected. · encrypted');
  });

  it('S.5: the Blob budget being spent says "The archive is full for today" (it used to say busy, and the test pinned that)', () => {
    enter('awaiting', {
      error: {
        code: 'RATE_LIMITED',
        message: 'The archive is full for today. Try again tomorrow.',
        detail: 'the archive has used its budget for today',
      },
    });
    render(<Stage />);
    expect(screen.getByRole('alert')).toHaveTextContent('The archive is full for today.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('busy');
  });

  it('the line of a rate limit depends on what the server said: busy for a full line, "many manuscripts" for an hourly limit, busy for the rest', () => {
    const say = (detail: string | undefined) => {
      enter('awaiting', {
        error: { code: 'RATE_LIMITED', message: 'x', ...(detail === undefined ? {} : { detail }) },
      });
      const { unmount } = render(<Stage />);
      const text = screen.getByRole('alert').querySelector('.in-world-error__line')?.textContent;
      unmount();
      return text;
    };
    expect(say('too many documents are waiting to be read')).toMatch(/The archive is busy/);
    expect(say('retry after 42 minutes')).toMatch(/many manuscripts in a short while/);
    expect(say(undefined)).toMatch(/The archive is busy/);
  });

  it('a ticket the server spent or refused, and a blob that never arrived, are not "no manuscript came"', () => {
    for (const [detail, text] of [
      ['the upload ticket was used already', /used already/],
      ['the upload ticket is not valid for this session', /another session/],
      ['no such blob', /did not reach the archive/],
    ] as const) {
      enter('awaiting', { error: { code: 'FILE_MISSING', message: 'x', detail } });
      const { unmount } = render(<Stage />);
      expect(screen.getByRole('alert').querySelector('.in-world-error__line')).toHaveTextContent(text);
      unmount();
    }
  });

  it('a 400 that is "not a question" (the server maps every 400 to it) reads as the internal fault here, never as "I could not read that question"', () => {
    enter('awaiting', { error: { code: 'QUESTION_INVALID', message: 'Body cannot be empty' } });
    render(<Stage />);
    const line = screen.getByRole('alert').querySelector('.in-world-error__line');
    expect(line).not.toHaveTextContent('question');
    expect(line).toHaveTextContent('The spell failed.');
  });

  describe('the free-tier notice (U-I2): in front of the reader before ANY first upload, whichever way it begins', () => {
    const noticeIn = (next: Phase, extra: Partial<ReturnType<typeof experienceStore.getState>> = {}) => {
      enter(next, extra);
      const { unmount } = render(<Stage />);
      const there = screen.queryByTestId('free-tier-notice') !== null;
      unmount();
      return there;
    };

    it('shown when the server says so: on the upload page, while uploading and reading; NOT on the welcome screen (nothing may cover its button) and not once the manuscript is bound', () => {
      configStore.getState().setConfig(config({ freeTierNotice: true }));
      expect(noticeIn('discovery')).toBe(false);
      expect(noticeIn('opening')).toBe(false);
      expect(noticeIn('awaiting')).toBe(true);
      expect(noticeIn('uploading')).toBe(true);
      expect(noticeIn('reading', { documentId: 'x' })).toBe(true);
      expect(noticeIn('manuscript', { documentId: 'x' })).toBe(false);
      enter('awaiting');
      render(<Stage />);
      expect(screen.getByTestId('free-tier-notice')).toHaveTextContent(/free model service/);
    });

    it('not shown when the server says there is nothing to disclose', () => {
      configStore.getState().setConfig(config());
      expect(noticeIn('awaiting')).toBe(false);
    });

    it('FAILS SAFE: shown while the configuration has not answered, and when it could not be read', () => {
      expect(configStore.getState().status).toBe('loading');
      expect(noticeIn('awaiting')).toBe(true);
      configStore.getState().setFailed();
      expect(noticeIn('awaiting')).toBe(true);
    });

    it('not before the session has been looked at (the first moments of the page)', () => {
      expect(noticeIn('awaiting', { sessionChecked: false })).toBe(false);
    });

    it('a file dropped on the welcome screen starts the upload, and the notice is on the screen with it (never over the Start button)', async () => {
      configStore.getState().setConfig(config({ freeTierNotice: true }));
      enter('discovery');
      render(<Stage />);
      expect(screen.queryByTestId('free-tier-notice')).toBeNull();
      drag('drop', [pdf()]);
      await waitFor(() => {
        expect(phase()).toBe('uploading');
      });
      expect(screen.getByTestId('free-tier-notice')).toBeInTheDocument();
    });

    it('is a quiet line that never takes a click (pointer-events none, in the stylesheet)', () => {
      const css = readFileSync(resolve(__dirname, '../../src/styles/upload.css'), 'utf8');
      const rule = /\.upload-portal__free-tier \{[^}]*\}/u.exec(css)?.[0] ?? '';
      expect(rule).toMatch(/pointer-events:\s*none/u);
    });
  });

  it("the portal's messages are a labelled, focusable, scrollable area inside the band; the button stays outside it", () => {
    enter('awaiting', {
      error: { code: 'PDF_ENCRYPTED', message: 'The PDF is password protected.', detail: 'encrypted' },
    });
    render(<Stage />);
    const messages = screen.getByRole('group', { name: 'What the diary says about the offer' });
    expect(messages).toHaveAttribute('tabindex', '0');
    expect(messages).toContainElement(screen.getByRole('alert'));
    expect(messages).not.toContainElement(screen.getByRole('button', { name: 'Offer a manuscript (PDF)' }));
  });

  it('a long technical code wraps instead of crossing the paper (the technical line keeps its own wrapping rule)', () => {
    enter('awaiting', {
      error: { code: 'INTERNAL', message: `x${'y'.repeat(300)}`, detail: 'z'.repeat(200) },
    });
    render(<Stage />);
    const technical = document.querySelector('.in-world-error__technical');
    expect(technical).toHaveClass('technical'); // .technical: overflow-wrap: anywhere (global.css)
  });
});

describe('dropping a file', () => {
  it('dragging a file over the window makes the book glow and shows the "release to offer" hint; leaving clears both', () => {
    enter('awaiting');
    render(<Stage />);
    expect(screen.queryByTestId('drop-hint')).toBeNull();
    drag('dragEnter', [pdf()]);
    expect(screen.getByTestId('drop-hint')).toHaveTextContent('Release to offer the manuscript');
    expect(pageEffectsStore.getState().values.edgeGlow).toBeGreaterThan(0.5);
    // moving over children fires enter/leave pairs: the drag has not left
    drag('dragEnter', [pdf()]);
    drag('dragLeave', [pdf()]);
    expect(screen.getByTestId('drop-hint')).toBeInTheDocument();
    drag('dragLeave', [pdf()]);
    expect(screen.queryByTestId('drop-hint')).toBeNull();
    expect(pageEffectsStore.getState().values.edgeGlow).toBe(0);
  });

  it('prevents the browser from opening a PDF dropped on the page, and ignores drags that carry no files', () => {
    enter('awaiting');
    render(<Stage />);
    expect(drag('dragOver', [pdf()]).defaultPrevented).toBe(true);
    expect(drag('drop', [], ['Files']).defaultPrevented).toBe(true);
    const text = drag('dragEnter', [], ['text/plain']);
    expect(text.defaultPrevented).toBe(false);
    expect(screen.queryByTestId('drop-hint')).toBeNull();
  });

  it('dropping anywhere in the stage while the diary waits offers it: awaiting -> uploading', async () => {
    enter('awaiting');
    render(<Stage />);
    const file = pdf('dropped.pdf');
    drag('dragEnter', [file]);
    drag('drop', [file]);
    expect(screen.queryByTestId('drop-hint')).toBeNull();
    await waitFor(() => {
      expect(phase()).toBe('uploading');
    });
    expect(experienceStore.getState().pendingFile).toBe(file);
  });

  it('dropping on the closed book (discovery) offers it too', async () => {
    enter('discovery');
    render(<Stage />);
    drag('drop', [pdf()]);
    await waitFor(() => {
      expect(phase()).toBe('uploading');
    });
  });

  it('while the diary is still reading: the "I am still reading" line, and nothing else happens', async () => {
    enter('reading', { documentId: 'x' });
    render(<Stage />);
    drag('drop', [pdf('second.pdf')]);
    expect(await screen.findByText(/I am still reading/)).toBeInTheDocument();
    expect(phase()).toBe('reading');
    expect(experienceStore.getState().pendingFile).toBeNull();
  });

  it('over a manuscript that is already bound it ASKS first; only confirming replaces it', async () => {
    enter('manuscript', { documentId: 'x' });
    documentStore.getState().setDocument(makeDocument());
    const user = userEvent.setup();
    render(<Stage />);
    const file = pdf('تقرير.pdf');
    drag('drop', [file]);
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Read this manuscript instead?');
    expect(dialog.querySelector('bdi')).toHaveTextContent('تقرير.pdf');
    expect(phase()).toBe('manuscript'); // nothing dispatched yet
    await user.click(within(dialog).getByRole('button', { name: 'Not now' }));
    expect(phase()).toBe('manuscript');
    drag('drop', [file]);
    await user.click(await screen.findByRole('button', { name: 'Read it instead' }));
    expect(experienceStore.getState()).toMatchObject({
      phase: 'closing',
      afterClose: 'uploading',
      pendingFile: file,
    });
  });

  it('a wrong file dropped over a manuscript is refused before any question is asked', async () => {
    enter('manuscript', { documentId: 'x' });
    render(<Stage />);
    drag('drop', [new File(['x'], 'notes.txt', { type: 'text/plain' })]);
    expect(await screen.findByRole('alert')).toHaveTextContent('FILE_NOT_PDF');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  describe('I-2: the browser never gets to open a dropped PDF (it would leave the diary), in EVERY phase', () => {
    const ALL: Phase[] = [
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

    it.each(ALL)('%s: dragenter, dragover and drop are all prevented', (next) => {
      enter(next, { documentId: 'x' });
      render(<Stage />);
      expect(drag('dragEnter', [pdf()]).defaultPrevented).toBe(true);
      expect(drag('dragOver', [pdf()]).defaultPrevented).toBe(true);
      expect(drag('drop', [pdf()]).defaultPrevented).toBe(true);
    });

    it('before the session has been looked at (the first moments of the page) too', () => {
      enter('discovery', { sessionChecked: false });
      render(<Stage />);
      expect(drag('dragOver', [pdf()]).defaultPrevented).toBe(true);
      expect(drag('drop', [pdf()]).defaultPrevented).toBe(true);
      // and the diary does nothing with it (it is not ready to be offered pages)
      expect(phase()).toBe('discovery');
      expect(experienceStore.getState().pendingFile).toBeNull();
    });

    it('a drag that carries no files is still left alone', () => {
      enter('closing');
      render(<Stage />);
      expect(drag('dragOver', [], ['text/plain']).defaultPrevented).toBe(false);
      expect(drag('drop', [], ['text/uri-list']).defaultPrevented).toBe(false);
    });

    it.each(['unveiling', 'revealing', 'closing'] as const)(
      '%s: the drop is turned away in the diary\'s voice ("turning its pages"), and nothing starts',
      async (next) => {
        enter(next, { documentId: 'x' });
        render(<Stage />);
        drag('drop', [pdf()]);
        expect(await screen.findByText(/The diary is turning its pages/)).toBeInTheDocument();
        expect(phase()).toBe(next);
        expect(experienceStore.getState().pendingFile).toBeNull();
        // no glow or hint was promised for it
        drag('dragEnter', [pdf()]);
        expect(screen.queryByTestId('drop-hint')).toBeNull();
        expect(pageEffectsStore.getState().values.edgeGlow).toBe(0);
      },
    );

    it('a wrong file dropped while the book turns its pages is also just turned away (never opened by the browser)', () => {
      enter('closing');
      render(<Stage />);
      expect(drag('drop', [new File(['x'], 'notes.txt', { type: 'text/plain' })]).defaultPrevented).toBe(
        true,
      );
    });

    it('the glow follows the phases that take a file: it goes out when the phase stops asking for one mid-drag', () => {
      enter('awaiting');
      render(<Stage />);
      drag('dragEnter', [pdf()]);
      expect(screen.getByTestId('drop-hint')).toBeInTheDocument();
      act(() => {
        enter('closing');
      });
      expect(screen.queryByTestId('drop-hint')).toBeNull();
      expect(pageEffectsStore.getState().values.edgeGlow).toBe(0);
    });
  });

  describe('R4: the closed book takes a drop (it opens the book and starts the upload), and its door is reachable by keyboard', () => {
    it('a drop in discovery goes to uploading with the file (the scene opens the cover for it: uploading shows the flyleaf)', async () => {
      enter('discovery');
      render(<Stage />);
      const file = pdf('first.pdf');
      drag('dragEnter', [file]);
      expect(screen.getByTestId('drop-hint')).toBeInTheDocument(); // the book says it takes it
      drag('drop', [file]);
      await waitFor(() => {
        expect(phase()).toBe('uploading');
      });
      expect(experienceStore.getState().pendingFile).toBe(file);
    });

    it('the welcome screen: the title and ONE button (English and Arabic), reached by Tab and operated by Enter; it plays the riffle by opening', async () => {
      const user = userEvent.setup();
      enter('discovery');
      render(<Welcome />);
      await user.tab();
      const start = screen.getByRole('button', { name: 'Start revealing the secrets' });
      expect(start).toHaveFocus();
      expect(screen.getAllByRole('button')).toHaveLength(1);
      await user.keyboard('{Enter}');
      expect(phase()).toBe('opening');
    });

    it('in Arabic the welcome has no English in it', () => {
      settingsStore.setState({ uiLanguage: 'ar' });
      enter('discovery');
      render(<Welcome />);
      expect(screen.getByRole('button', { name: 'ابدأ كشف الأسرار' })).toBeInTheDocument();
      expect(screen.getByTestId('welcome').textContent).not.toMatch(/[A-Za-z]/);
    });

    it('it is there only on the closed book, once the session is checked', () => {
      enter('discovery', { sessionChecked: false });
      const { unmount } = render(<Welcome />);
      expect(screen.queryByTestId('welcome')).toBeNull();
      unmount();
      enter('awaiting');
      render(<Welcome />);
      expect(screen.queryByTestId('welcome')).toBeNull();
    });
  });
});

describe('the ingestion progress', () => {
  const line = () =>
    screen.getByTestId('ingest-progress').querySelector('.ingest-progress__line')!.textContent;

  it('upload: real bytes, "Opening the manuscript… 4.2 of 9.8 MB"', () => {
    enter('uploading');
    documentStore.getState().setUploadProgress({ loaded: 4.2 * 1024 * 1024, total: 9.8 * 1024 * 1024 });
    render(<Stage />);
    expect(line()).toBe('Opening the manuscript… 4.2 of 9.8 MB');
  });

  it("once every byte is sent the line is the server's check of the file (the 202 is still on its way)", () => {
    enter('uploading');
    documentStore.getState().setUploadProgress({ loaded: 1000, total: 1000 });
    render(<Stage />);
    expect(line()).toBe('Checking the manuscript’s binding…');
  });

  it.each([
    [{ stage: 'parsing', completed: 12, total: 40, unit: 'pages' }, 'Examining the pages… 12 of 40'],
    [{ stage: 'ocr', completed: 2, total: 3, unit: 'pages' }, 'Reading the faded writing… page 2 of 3'],
    [
      { stage: 'embedding', completed: 96, total: 312, unit: 'chunks' },
      'Binding the words to memory… 96 of 312 passages',
    ],
    [{ stage: 'chunking', completed: 3, total: 9, unit: 'steps' }, 'Gathering its pages… step 3 of 9'],
    [
      { stage: 'queued', completed: 0, total: 0, unit: 'queue', queuePosition: 2 },
      'Waiting my turn at the archive… Other manuscripts waiting at the archive: 2.',
    ],
  ] as const)('reading: %j shows real counts', (progress, expected) => {
    enter('reading', { documentId: 'x' });
    documentStore.getState().setIngestProgress(progress);
    render(<Stage />);
    expect(line()).toBe(expected);
  });

  it('writes the counts in Arabic-Indic digits in the Arabic interface', () => {
    settingsStore.setState({ uiLanguage: 'ar' });
    enter('reading', { documentId: 'x' });
    documentStore.getState().setIngestProgress({ stage: 'parsing', completed: 12, total: 40, unit: 'pages' });
    render(<Stage />);
    expect(line()).toContain('١٢ من ٤٠');
  });

  it('never shows a percentage: no "%" anywhere, only counts', () => {
    enter('reading', { documentId: 'x' });
    documentStore
      .getState()
      .setIngestProgress({ stage: 'embedding', completed: 96, total: 312, unit: 'chunks' });
    render(<Stage />);
    expect(screen.getByTestId('ingest-progress').textContent).not.toMatch(/%|percent/i);
  });

  it('the edges of the book glow with the REAL fraction of the stage, and the glow is let go when the progress is gone', () => {
    enter('reading', { documentId: 'x' });
    documentStore.getState().setIngestProgress({ stage: 'parsing', completed: 20, total: 40, unit: 'pages' });
    const { unmount } = render(<Stage />);
    expect(pageEffectsStore.getState().sources.progress.edgeGlow).toBeCloseTo(0.25 + 0.75 * 0.5, 6);
    act(() => {
      documentStore
        .getState()
        .setIngestProgress({ stage: 'parsing', completed: 40, total: 40, unit: 'pages' });
    });
    expect(pageEffectsStore.getState().sources.progress.edgeGlow).toBeCloseTo(1, 6);
    unmount();
    expect(pageEffectsStore.getState().sources.progress.edgeGlow).toBe(0);
  });

  it('the upload drives the glow with the bytes sent', () => {
    enter('uploading');
    documentStore.getState().setUploadProgress({ loaded: 250, total: 1000 });
    render(<Stage />);
    expect(pageEffectsStore.getState().sources.progress.edgeGlow).toBeCloseTo(0.25 + 0.75 * 0.25, 6);
  });

  it('a polite live region carries the text, and changes only when the stage does or a quarter more is done', () => {
    enter('reading', { documentId: 'x' });
    documentStore.getState().setIngestProgress({ stage: 'parsing', completed: 1, total: 40, unit: 'pages' });
    render(<Stage />);
    const region = screen.getByRole('status', { name: 'How far the diary has read' });
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('Examining the pages… 1 of 40');
    act(() => {
      documentStore
        .getState()
        .setIngestProgress({ stage: 'parsing', completed: 5, total: 40, unit: 'pages' });
    });
    expect(region).toHaveTextContent('Examining the pages… 1 of 40'); // same quarter: not repeated
    act(() => {
      documentStore
        .getState()
        .setIngestProgress({ stage: 'parsing', completed: 12, total: 40, unit: 'pages' });
    });
    expect(region).toHaveTextContent('Examining the pages… 12 of 40');
    act(() => {
      documentStore.getState().setIngestProgress({ stage: 'ocr', completed: 0, total: 3, unit: 'pages' });
    });
    expect(region).toHaveTextContent('Reading the faded writing… page 0 of 3');
  });

  it('a parked document: the diary must rest, resumes after the daily reset (with the time), and the technical detail', () => {
    enter('reading', { documentId: 'x' });
    documentStore
      .getState()
      .setIngestProgress({ stage: 'embedding', completed: 10, total: 100, unit: 'chunks' });
    documentStore.getState().setIngestPause({
      kind: 'parked',
      retryAt: new Date('2026-10-03T09:00:00Z').getTime(),
      detail: 'daily quota reached',
    });
    render(<Stage />);
    const box = screen.getByTestId('ingest-progress');
    expect(box).toHaveTextContent('The diary must rest.');
    expect(box).toHaveTextContent(/It resumes after the daily reset, around \d{1,2}:\d{2}/);
    expect(box.querySelector('.technical')).toHaveTextContent('daily quota reached');
  });

  it('a waiting tick says the archive asks for a moment', () => {
    enter('reading', { documentId: 'x' });
    documentStore.getState().setIngestPause({ kind: 'waiting', retryAt: Date.now() + 5000 });
    render(<Stage />);
    expect(screen.getByTestId('ingest-progress')).toHaveTextContent('The archive asks for a moment.');
  });

  it('"Withdraw the manuscript" cancels (uploading and reading both)', async () => {
    const user = userEvent.setup();
    enter('uploading');
    render(<Stage />);
    await user.click(screen.getByRole('button', { name: 'Withdraw the manuscript' }));
    expect(phase()).toBe('awaiting');
    act(() => {
      enter('reading', { documentId: 'x' });
    });
    await user.click(screen.getByRole('button', { name: 'Withdraw the manuscript' }));
    expect(phase()).toBe('awaiting');
  });

  it('sits on the flyleaf (ink on parchment) while uploading and under the closed book (parchment on the stage) while reading', () => {
    enter('uploading');
    const { unmount } = render(<Stage />);
    expect(screen.getByTestId('ingest-progress')).toHaveAttribute('data-surface', 'flyleaf');
    unmount();
    enter('reading', { documentId: 'x' });
    render(<Stage />);
    expect(screen.getByTestId('ingest-progress')).toHaveAttribute('data-surface', 'stage');
  });

  it('is not there when nothing is uploading or being read', () => {
    for (const other of ['discovery', 'awaiting', 'unveiling', 'manuscript'] as const) {
      enter(other);
      const { unmount } = render(<Stage />);
      expect(screen.queryByTestId('ingest-progress'), other).toBeNull();
      unmount();
    }
  });
});
