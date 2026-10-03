import { describe, expect, it, vi } from 'vitest';
import { createConfigStore } from '../../src/state/configStore';
import { createConfirmStore } from '../../src/state/confirmStore';
import { createExperienceStore, initialExperienceState, type Phase } from '../../src/state/experience';
import { offerFile } from '../../src/state/offerFile';
import { createUploadNoticeStore } from '../../src/state/uploadNotice';

const pdf = (name = 'a.pdf') => new File(['%PDF-1.7'], name, { type: 'application/pdf' });

function setup(phase: Phase, extra: Partial<typeof initialExperienceState> = {}) {
  const experience = createExperienceStore({
    ...initialExperienceState,
    phase,
    sessionChecked: true,
    ...extra,
  });
  const notices = createUploadNoticeStore();
  const confirm = createConfirmStore();
  const config = createConfigStore();
  const validate = vi.fn(() => Promise.resolve({ ok: true as const }));
  const deps = { experience, notices, confirm, config, validate };
  return { experience, notices, confirm, validate, offer: (file: File) => offerFile(file, deps) };
}

describe('offerFile decides what the DIARY does with a file, by phase', () => {
  it.each(['discovery', 'opening', 'awaiting'] as const)(
    '%s: validated, then FILE_SELECTED (the upload begins)',
    async (phase) => {
      const h = setup(phase);
      const file = pdf();
      await h.offer(file);
      expect(h.validate).toHaveBeenCalled();
      expect(h.experience.getState()).toMatchObject({ phase: 'uploading', pendingFile: file });
    },
  );

  it.each(['uploading', 'reading'] as const)(
    '%s: "still reading", nothing validated, nothing changes',
    async (phase) => {
      const h = setup(phase);
      await h.offer(pdf('second.pdf'));
      expect(h.notices.getState().notice).toEqual({ kind: 'stillReading', fileName: 'second.pdf' });
      expect(h.validate).not.toHaveBeenCalled();
      expect(h.experience.getState().phase).toBe(phase);
    },
  );

  it.each(['unveiling', 'revealing', 'closing'] as const)(
    '%s: "the book is turning its pages", no upload, no question',
    async (phase) => {
      const h = setup(phase);
      await h.offer(pdf('x.pdf'));
      expect(h.notices.getState().notice).toEqual({ kind: 'busy', fileName: 'x.pdf' });
      expect(h.validate).not.toHaveBeenCalled();
      expect(h.confirm.getState().request).toBeNull();
      expect(h.experience.getState().phase).toBe(phase);
    },
  );

  it.each(['manuscript', 'memory'] as const)(
    '%s: asks first (the diary would forget what it holds)',
    async (phase) => {
      const h = setup(phase);
      const file = pdf();
      await h.offer(file);
      expect(h.confirm.getState().request).toEqual({ kind: 'replace', file });
      expect(h.experience.getState().phase).toBe(phase);
    },
  );

  it('before the session has been looked at: ignored, silently', async () => {
    const h = setup('discovery', { sessionChecked: false });
    await h.offer(pdf());
    expect(h.notices.getState().notice).toBeNull();
    expect(h.validate).not.toHaveBeenCalled();
    expect(h.experience.getState().phase).toBe('discovery');
  });

  it("a refused file is told in the diary's voice (with the reason) and nothing starts", async () => {
    const h = setup('awaiting');
    h.validate.mockResolvedValue({
      ok: false,
      error: { code: 'FILE_NOT_PDF', message: 'x', detail: 'name: a.txt' },
    } as never);
    await h.offer(pdf());
    expect(h.notices.getState().notice).toMatchObject({ kind: 'rejected', error: { code: 'FILE_NOT_PDF' } });
    expect(h.experience.getState().phase).toBe('awaiting');
  });

  it('shows a file name only after sanitising it (a right-to-left override cannot spoof the extension)', async () => {
    const h = setup('uploading');
    await h.offer(pdf('invoice‮fdp.exe'));
    expect(h.notices.getState().notice).toEqual({ kind: 'stillReading', fileName: 'invoicefdp.exe' });
  });

  it('what the diary is doing can change while the file is read: it decides on what it is doing NOW', async () => {
    const h = setup('awaiting');
    h.validate.mockImplementation(() => {
      h.experience.getState().dispatch({ type: 'CLOSE_REQUESTED' }); // the reader closed the diary meanwhile
      return Promise.resolve({ ok: true as const });
    });
    await h.offer(pdf());
    expect(h.experience.getState().phase).toBe('closing');
    expect(h.experience.getState().pendingFile).toBeNull();
  });
});
