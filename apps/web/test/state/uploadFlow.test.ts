import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { documentStore } from '../../src/state/documentStore';
import { startCloseEffect } from '../../src/state/effects/close';
import { startIngestEffect } from '../../src/state/effects/ingest';
import { startSessionEffect } from '../../src/state/effects/session';
import { startUploadEffect } from '../../src/state/effects/upload';
import { experienceStore, initialExperienceState } from '../../src/state/experience';
import { configStore } from '../../src/state/configStore';
import { offerFile } from '../../src/state/offerFile';
import { uploadNoticeStore } from '../../src/state/uploadNotice';
import { DOCUMENT_ID, makeDocument } from '../fixtures';
import { apiError, FakeXhr, installFetch, json } from '../helpers/network';

/*
 * The upload flow end to end through the REAL state machine and the REAL effects, with the network (fetch and
 * XMLHttpRequest) replaced at its boundary: a file offered in `awaiting` goes uploading -> reading -> unveiling, with the
 * bytes and the ingestion's counts reported as they arrive.
 */

const SUMMARY = {
  id: DOCUMENT_ID,
  filename: 'manuscript.pdf',
  byteSize: 8,
  pageCount: 40,
  status: 'processing',
  stage: 'queued',
  primaryLanguage: 'und',
  direction: 'ltr',
  createdAt: '2026-10-02T10:00:00.000Z',
  expiresAt: '2026-10-03T10:00:00.000Z',
};
const progress = (stage: string, completed: number, total: number, unit = 'pages') => ({
  stage,
  completed,
  total,
  unit,
});

let stops: (() => void)[] = [];
beforeEach(() => {
  documentStore.getState().reset();
  uploadNoticeStore.getState().clear();
  configStore.getState().setConfig(null);
  experienceStore.setState({ ...initialExperienceState, phase: 'awaiting', sessionChecked: true });
  FakeXhr.install();
  stops = [startCloseEffect(), startUploadEffect(), startIngestEffect()];
});
afterEach(() => {
  for (const stop of stops) stop();
  vi.unstubAllGlobals();
});

const pdf = (name = 'manuscript.pdf') =>
  new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])], name, {
    type: 'application/pdf',
  });

describe('offering a manuscript: uploading -> reading -> unveiling', () => {
  it('drives the state machine through every phase with real counts from the events', async () => {
    const ticks = [
      { status: 'running', progress: progress('parsing', 12, 40) },
      { status: 'running', progress: progress('ocr', 2, 3) },
      { status: 'running', progress: progress('embedding', 96, 312, 'chunks') },
      { status: 'ready', progress: progress('ready', 40, 40), document: makeDocument({ pageCount: 40 }) },
    ];
    const { calls } = installFetch({
      'POST /api/uploads/ticket': () => json(200, { mode: 'direct', maxBytes: 20_000_000 }),
      [`POST /api/documents/${DOCUMENT_ID}/tick`]: () => json(200, ticks.shift()),
    });
    const phases: string[] = [];
    experienceStore.subscribe((state, previous) => {
      if (state.phase !== previous.phase) phases.push(state.phase);
    });
    const seenProgress: unknown[] = [];
    documentStore.subscribe((state) => {
      if (state.ingestProgress) seenProgress.push(state.ingestProgress);
    });
    const seenBytes: unknown[] = [];
    documentStore.subscribe((state) => {
      if (state.uploadProgress) seenBytes.push(state.uploadProgress);
    });

    const file = pdf();
    await offerFile(file);
    expect(experienceStore.getState().phase).toBe('uploading');
    await vi.waitFor(() => {
      expect(FakeXhr.instances).toHaveLength(1);
    });
    FakeXhr.last().progress(4, 220);
    FakeXhr.last().progress(228, 228);
    FakeXhr.last().respond(202, { document: SUMMARY });
    await vi.waitFor(() => {
      expect(experienceStore.getState().phase).toBe('unveiling');
    });

    expect(phases).toEqual(['uploading', 'reading', 'unveiling']);
    expect(experienceStore.getState().documentId).toBe(DOCUMENT_ID);
    // the real bytes (never more than the file: the multipart body is a little bigger) ...
    expect(seenBytes).toContainEqual({ loaded: 4, total: 8 });
    expect(seenBytes).toContainEqual({ loaded: 8, total: 8 });
    // ... and the real counts of every step the server reported
    expect(seenProgress).toContainEqual(progress('parsing', 12, 40));
    expect(seenProgress).toContainEqual(progress('ocr', 2, 3));
    expect(seenProgress).toContainEqual(progress('embedding', 96, 312, 'chunks'));
    // the ready document is in the store, with the file the reader offered
    expect(documentStore.getState().document).toMatchObject({
      id: DOCUMENT_ID,
      status: 'ready',
      pageCount: 40,
    });
    expect(documentStore.getState().file).toBe(file);
    expect(calls.filter((call) => call.path.endsWith('/tick'))).toHaveLength(4);
  });

  it('a server refusal returns the diary to awaiting with the in-world error to show', async () => {
    installFetch({ 'POST /api/uploads/ticket': () => json(200, { mode: 'direct', maxBytes: 20_000_000 }) });
    await offerFile(pdf());
    await vi.waitFor(() => {
      expect(FakeXhr.instances).toHaveLength(1);
    });
    FakeXhr.last().respond(422, {
      error: { code: 'PDF_ENCRYPTED', message: 'The PDF is password protected.' },
    });
    await vi.waitFor(() => {
      expect(experienceStore.getState().phase).toBe('awaiting');
    });
    expect(experienceStore.getState().error).toMatchObject({ code: 'PDF_ENCRYPTED' });
    expect(documentStore.getState().uploadProgress).toBeNull();
  });

  it('a busy archive on the ticket (429) is RATE_LIMITED and nothing is sent', async () => {
    installFetch({
      'POST /api/uploads/ticket': () => apiError(429, 'RATE_LIMITED', 'The archive is full for today'),
    });
    await offerFile(pdf());
    await vi.waitFor(() => {
      expect(experienceStore.getState().phase).toBe('awaiting');
    });
    expect(experienceStore.getState().error).toMatchObject({ code: 'RATE_LIMITED' });
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it('a document the server then fails to read returns to awaiting with the code (PDF_UNREADABLE)', async () => {
    installFetch({
      'POST /api/uploads/ticket': () => json(200, { mode: 'direct', maxBytes: 20_000_000 }),
      [`POST /api/documents/${DOCUMENT_ID}/tick`]: () =>
        json(200, {
          status: 'failed',
          progress: progress('failed', 0, 0),
          error: { code: 'PDF_UNREADABLE', message: 'no pages could be read' },
        }),
    });
    await offerFile(pdf());
    await vi.waitFor(() => {
      expect(FakeXhr.instances).toHaveLength(1);
    });
    FakeXhr.last().respond(202, { document: SUMMARY });
    await vi.waitFor(() => {
      expect(experienceStore.getState().phase).toBe('awaiting');
    });
    expect(experienceStore.getState().error).toMatchObject({ code: 'PDF_UNREADABLE' });
  });

  it('withdrawing during the reading aborts the loop and deletes the document; the diary waits again', async () => {
    const { calls } = installFetch({
      'POST /api/uploads/ticket': () => json(200, { mode: 'direct', maxBytes: 20_000_000 }),
      [`POST /api/documents/${DOCUMENT_ID}/tick`]: () =>
        json(200, { status: 'running', progress: progress('parsing', 1, 40), retryAfterMs: 60_000 }),
      [`DELETE /api/documents/${DOCUMENT_ID}`]: () => new Response(null, { status: 204 }),
    });
    await offerFile(pdf());
    await vi.waitFor(() => {
      expect(FakeXhr.instances).toHaveLength(1);
    });
    FakeXhr.last().respond(202, { document: SUMMARY });
    await vi.waitFor(() => {
      expect(experienceStore.getState().phase).toBe('reading');
    });
    await vi.waitFor(() => {
      expect(calls.some((call) => call.path.endsWith('/tick'))).toBe(true);
    });
    experienceStore.getState().dispatch({ type: 'CANCEL' });
    expect(experienceStore.getState()).toMatchObject({ phase: 'awaiting', error: null });
    await vi.waitFor(() => {
      expect(calls.some((call) => call.method === 'DELETE')).toBe(true);
    });
  });

  it('a restored session that left a document processing resumes ticking it: SESSION_CHECKED{processing} through the REAL session effect and the REAL boot order', async () => {
    const ready = makeDocument({ pageCount: 5 });
    const processing = makeDocument({ status: 'processing', stage: 'parsing', pageCount: 5 });
    const { calls } = installFetch({
      'GET /api/session/document': () => json(200, { document: processing }),
      [`POST /api/documents/${DOCUMENT_ID}/tick`]: () =>
        json(200, { status: 'ready', progress: progress('ready', 5, 5), document: ready }),
    });
    // the page has just loaded: the closed book, the session not yet looked at (the effects were started in beforeEach, BEFORE
    // the check, as boot.ts does: a restored processing document goes straight to `reading`)
    experienceStore.setState({ ...initialExperienceState });
    const phases: string[] = [];
    experienceStore.subscribe((state, previous) => {
      if (state.phase !== previous.phase) phases.push(state.phase);
    });
    stops.push(startSessionEffect());
    await vi.waitFor(() => {
      expect(experienceStore.getState().phase).toBe('unveiling');
    });
    expect(phases).toEqual(['reading', 'unveiling']);
    expect(calls.some((call) => call.path === `/api/documents/${DOCUMENT_ID}/tick`)).toBe(true);
    expect(documentStore.getState().document).toEqual(ready);
    expect(FakeXhr.instances).toHaveLength(0); // nothing was uploaded: it is the same document
  });

  it('a restored session whose check answered LATE (a cold start) still resumes the reading', async () => {
    vi.useFakeTimers();
    try {
      const processing = makeDocument({ status: 'processing', stage: 'parsing', pageCount: 5 });
      let answer: (response: Response) => void = () => undefined;
      installFetch({
        'GET /api/session/document': () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
        [`POST /api/documents/${DOCUMENT_ID}/tick`]: () =>
          json(200, { status: 'running', progress: progress('parsing', 1, 5), retryAfterMs: 60_000 }),
      });
      experienceStore.setState({ ...initialExperienceState });
      stops.push(startSessionEffect());
      await vi.advanceTimersByTimeAsync(2000);
      expect(experienceStore.getState()).toMatchObject({ phase: 'discovery', sessionChecked: true });
      answer(json(200, { document: processing }));
      await vi.advanceTimersByTimeAsync(0);
      expect(experienceStore.getState()).toMatchObject({ phase: 'reading', documentId: DOCUMENT_ID });
    } finally {
      vi.useRealTimers();
    }
  });
});
