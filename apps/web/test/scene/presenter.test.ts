import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { desiredDirection } from '../../src/scene/book/bookPresenter';
import { documentStore } from '../../src/state/documentStore';
import { readerStore } from '../../src/state/readerStore';
import { anchorStore } from '../../src/state/anchorStore';
import { makeDocument } from '../fixtures';

beforeEach(() => {
  readerStore.getState().reset();
  readerStore.getState().setDirection('ltr');
  documentStore.getState().reset();
  anchorStore.getState().reset();
});
afterEach(() => {
  documentStore.getState().reset();
  readerStore.getState().reset();
});

describe('the direction the 3D book should have', () => {
  it('outside reading and unveiling it is the reader direction', () => {
    readerStore.getState().setDirection('rtl');
    for (const phase of ['discovery', 'opening', 'awaiting', 'manuscript', 'closing'] as const) {
      expect(desiredDirection(phase)).toBe('rtl');
    }
  });

  it('while the diary reads, the direction the analysis reports wins as soon as it is known', () => {
    expect(desiredDirection('reading')).toBe('ltr');
    documentStore
      .getState()
      .setIngestProgress({ stage: 'analyzing', completed: 1, total: 4, unit: 'pages', direction: 'rtl' });
    expect(desiredDirection('reading')).toBe('rtl');
    expect(desiredDirection('unveiling')).toBe('rtl');
    // A stale progress report must not leak into other phases.
    expect(desiredDirection('awaiting')).toBe('ltr');
  });

  it('keeps the reported direction while later progress events (with none) replace each other', () => {
    const store = documentStore.getState();
    store.setIngestProgress({ stage: 'analyzing', completed: 1, total: 4, unit: 'pages', direction: 'rtl' });
    for (const stage of ['chunking', 'embedding', 'storing'] as const) {
      store.setIngestProgress({ stage, completed: 1, total: 4, unit: 'chunks' });
      expect(desiredDirection('reading')).toBe('rtl');
    }
    expect(desiredDirection('unveiling')).toBe('rtl');
  });

  it('a document that is still processing does not decide; the reported direction and then the interface do', () => {
    documentStore.getState().setDocument(makeDocument({ status: 'processing', direction: 'ltr' }));
    expect(desiredDirection('reading')).toBe('ltr');
    readerStore.getState().setDirection('rtl');
    expect(desiredDirection('reading')).toBe('rtl');
    documentStore
      .getState()
      .setIngestProgress({ stage: 'analyzing', completed: 1, total: 4, unit: 'pages', direction: 'ltr' });
    expect(desiredDirection('reading')).toBe('ltr');
  });

  it('the finished document decides over the progress report', () => {
    documentStore
      .getState()
      .setIngestProgress({ stage: 'analyzing', completed: 1, total: 4, unit: 'pages', direction: 'rtl' });
    documentStore.getState().setDocument(makeDocument({ direction: 'ltr' }));
    expect(desiredDirection('unveiling')).toBe('ltr');
  });
});

describe('the layout direction in the anchor store', () => {
  it('starts LTR, can be set, and is only announced when it changes', () => {
    expect(anchorStore.getState().layoutDirection).toBe('ltr');
    const seen: string[] = [];
    const stop = anchorStore.subscribe((state) => seen.push(state.layoutDirection));
    anchorStore.getState().setLayoutDirection('rtl');
    anchorStore.getState().setLayoutDirection('rtl');
    expect(seen).toEqual(['rtl']);
    stop();
  });
});
