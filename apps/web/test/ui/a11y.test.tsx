import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { documentStore } from '../../src/state/documentStore';
import { experienceStore, initialExperienceState, type Phase } from '../../src/state/experience';
import { readerStore } from '../../src/state/readerStore';
import { settingsStore } from '../../src/state/settingsStore';
import { confirmStore } from '../../src/state/confirmStore';
import { ConfirmDialogHost } from '../../src/ui/reader/ConfirmDialog';
import { ReaderBar } from '../../src/ui/reader/ReaderBar';
import { ReaderUi } from '../../src/ui/reader/ReaderUi';
import { IngestProgress } from '../../src/ui/progress/IngestProgress';
import { UploadPortal } from '../../src/ui/upload/UploadPortal';
import { resetStores } from '../components/helpers';
import { makeDocument } from '../fixtures';

/* The new interface checked by axe-core (jsdom has no layout, so colour contrast is measured in the browser run instead). */

async function violations(container: Element) {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  return results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} (${violation.nodes.map((node) => node.html.slice(0, 80)).join(' | ')})`,
  );
}

function enter(phase: Phase, extra: Partial<ReturnType<typeof experienceStore.getState>> = {}): void {
  experienceStore.setState({ ...initialExperienceState, phase, sessionChecked: true, ...extra });
}

function openManuscript(direction: 'ltr' | 'rtl' = 'ltr'): void {
  documentStore
    .getState()
    .setDocument(
      makeDocument({ pageCount: 12, direction, primaryLanguage: direction === 'rtl' ? 'ar' : 'en' }),
    );
  readerStore.getState().setDocument(12, direction);
  readerStore.getState().goToSpread(1);
  enter('manuscript', { documentId: 'x' });
}

function Stage() {
  return (
    <>
      <UploadPortal />
      <IngestProgress />
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
});

describe('accessibility of the upload and reader interface (axe-core)', () => {
  it('the flyleaf controls while the diary waits, with an error showing', async () => {
    enter('awaiting', { error: { code: 'PDF_ENCRYPTED', message: 'The PDF is password protected.' } });
    const { container } = render(<Stage />);
    expect(await violations(container)).toEqual([]);
  });

  it('the progress while uploading and while reading, parked included', async () => {
    enter('uploading');
    documentStore.getState().setUploadProgress({ loaded: 10, total: 100 });
    const { container, unmount } = render(<Stage />);
    expect(await violations(container)).toEqual([]);
    unmount();
    enter('reading', { documentId: 'x' });
    documentStore
      .getState()
      .setIngestProgress({ stage: 'embedding', completed: 3, total: 9, unit: 'chunks' });
    documentStore
      .getState()
      .setIngestPause({ kind: 'parked', retryAt: Date.now() + 3600_000, detail: 'daily quota reached' });
    const second = render(<Stage />);
    expect(await violations(second.container)).toEqual([]);
  });

  it.each(['ltr', 'rtl'] as const)('the reader: bar, menu and confirmation (%s)', async (direction) => {
    const user = userEvent.setup();
    openManuscript(direction);
    if (direction === 'rtl')
      act(() => {
        settingsStore.setState({ uiLanguage: 'ar' });
      });
    const { container } = render(<Stage />);
    expect(await violations(container)).toEqual([]);
    await user.click(
      screen.getByRole('button', { name: direction === 'rtl' ? 'قائمة المذكّرة' : 'Diary menu' }),
    );
    expect(await violations(container)).toEqual([]);
    await user.keyboard('{Escape}');
    act(() => {
      confirmStore.getState().ask({ kind: 'close' });
    });
    expect(await violations(container)).toEqual([]);
  });
});
