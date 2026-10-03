import { describe, expect, it } from 'vitest';
import type { Message } from '@enchanted/shared';
import { createChatStore } from '../../src/state/chatStore';
import { createDocumentStore } from '../../src/state/documentStore';
import { makeDocument, makeFile } from '../fixtures';

describe('documentStore', () => {
  it('starts empty', () => {
    expect(createDocumentStore().getState()).toMatchObject({
      document: null,
      file: null,
      fileUrl: null,
      pdf: null,
      ingestProgress: null,
      uploadProgress: null,
    });
  });

  describe('the direction the analysis reported', () => {
    const analyzing = {
      stage: 'analyzing',
      completed: 1,
      total: 4,
      unit: 'pages',
      direction: 'rtl',
    } as const;
    const chunking = { stage: 'chunking', completed: 3, total: 30, unit: 'chunks' } as const;

    it('is kept when later progress events (which carry no direction) replace the latest event', () => {
      const store = createDocumentStore();
      expect(store.getState().reportedDirection).toBeNull();
      store.getState().setIngestProgress(analyzing);
      store.getState().setIngestProgress(chunking);
      expect(store.getState().ingestProgress).toEqual(chunking);
      expect(store.getState().reportedDirection).toBe('rtl');
    });

    it('is forgotten when progress is cleared, the document is removed, a new file is chosen or the store resets', () => {
      const store = createDocumentStore();
      const report = (): void => {
        store.getState().setIngestProgress(analyzing);
      };
      report();
      store.getState().setIngestProgress(null);
      expect(store.getState().reportedDirection).toBeNull();
      report();
      store.getState().setDocument(null);
      expect(store.getState().reportedDirection).toBeNull();
      report();
      store.getState().setFile(makeFile());
      expect(store.getState().reportedDirection).toBeNull();
      report();
      store.getState().reset();
      expect(store.getState().reportedDirection).toBeNull();
    });

    it('survives the file being set to null (a restored session keeps a URL, not a file)', () => {
      const store = createDocumentStore();
      store.getState().setIngestProgress(analyzing);
      store.getState().setFile(null, '/api/documents/x/file');
      expect(store.getState().reportedDirection).toBe('rtl');
    });
  });

  it('holds the document, the file, progress and the shared PDF handle, and resets', () => {
    const store = createDocumentStore();
    const document = makeDocument();
    const file = makeFile();
    store.getState().setDocument(document);
    store.getState().setFile(file);
    store.getState().setIngestProgress({ stage: 'parsing', completed: 2, total: 5, unit: 'pages' });
    store.getState().setUploadProgress({ loaded: 10, total: 100 });
    expect(store.getState()).toMatchObject({
      document,
      file,
      fileUrl: null,
      ingestProgress: { stage: 'parsing', completed: 2, total: 5, unit: 'pages' },
      uploadProgress: { loaded: 10, total: 100 },
    });
    store.getState().setFile(null, '/api/documents/x/file');
    expect(store.getState()).toMatchObject({ file: null, fileUrl: '/api/documents/x/file' });
    store.getState().reset();
    expect(store.getState()).toMatchObject({
      document: null,
      file: null,
      fileUrl: null,
      ingestProgress: null,
      uploadProgress: null,
    });
  });

  it('gives every store instance its own state', () => {
    const a = createDocumentStore();
    const b = createDocumentStore();
    a.getState().setDocument(makeDocument());
    expect(b.getState().document).toBeNull();
  });
});

describe('chatStore', () => {
  const message: Message = {
    id: '3b6f1f0e-8a52-4d6b-9d0c-6f1f6d0b7e11',
    role: 'user',
    kind: 'question',
    content: 'Who founded it?',
    citations: [],
    createdAt: '2026-10-01T10:00:00.000Z',
  };

  it('starts idle with no messages', () => {
    expect(createChatStore().getState()).toMatchObject({ messages: [], askStatus: 'idle', error: null });
  });

  it('appends and replaces messages, tracks status and errors, and resets', () => {
    const store = createChatStore();
    store.getState().appendMessage(message);
    store.getState().appendMessage({
      ...message,
      id: '0c9b1e52-4a0b-4f0f-b9f6-2f1d5c3a9e77',
      role: 'assistant',
      kind: 'answer',
    });
    expect(store.getState().messages).toHaveLength(2);
    store.getState().setAskStatus('retrieving');
    store.getState().setError({ code: 'LLM_FAILED', message: 'upstream 502' });
    expect(store.getState()).toMatchObject({ askStatus: 'retrieving', error: { code: 'LLM_FAILED' } });
    store.getState().setMessages([message]);
    expect(store.getState().messages).toEqual([message]);
    store.getState().reset();
    expect(store.getState()).toMatchObject({ messages: [], askStatus: 'idle', error: null });
  });
});
