import type { DocumentDetail } from '@enchanted/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDocumentStore, type DocumentStore } from '../../src/state/documentStore';
import { createExperienceStore, type ExperienceStore } from '../../src/state/experience';
import { startReaderSync } from '../../src/state/readerSync';
import { createReaderStore, type ReaderStore } from '../../src/state/readerStore';
import { createSettingsStore, type SettingsStore } from '../../src/state/settingsStore';

function document(overrides: Partial<DocumentDetail> = {}): DocumentDetail {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    filename: 'a.pdf',
    byteSize: 10,
    pageCount: 12,
    status: 'ready',
    stage: 'ready',
    primaryLanguage: 'en',
    direction: 'ltr',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-02T00:00:00.000Z',
    languages: [],
    pages: [],
    warnings: [],
    sections: [],
    chunkCount: 0,
    ...overrides,
  };
}

let documents: DocumentStore;
let reader: ReaderStore;
let settings: SettingsStore;
let experience: ExperienceStore;
let stop: () => void;

/** Moves the experience to `phase` the way its reducer would: a new epoch. */
function enter(phase: 'unveiling' | 'manuscript' | 'reading' | 'closing' | 'revealing' | 'memory'): void {
  experience.setState({ phase, epoch: experience.getState().epoch + 1 });
}

beforeEach(() => {
  documents = createDocumentStore();
  reader = createReaderStore();
  settings = createSettingsStore({ storage: null, matchMedia: null, language: 'en' });
  experience = createExperienceStore({ phase: 'reading', epoch: 1, sessionChecked: true });
  stop = startReaderSync(documents, reader, settings, experience);
});

afterEach(() => {
  stop();
  settings.dispose();
});

describe('startReaderSync', () => {
  it('a ready document gives the reader its page count and direction', () => {
    documents.getState().setDocument(document({ pageCount: 30, direction: 'rtl' }));
    expect(reader.getState()).toMatchObject({ pageCount: 30, direction: 'rtl', hasDocument: true });
  });

  it('a document still being processed is not a book yet', () => {
    documents.getState().setDocument(document({ status: 'processing', pageCount: 0 }));
    expect(reader.getState().hasDocument).toBe(false);
  });

  it('removing the document empties the reader and returns to the interface direction', () => {
    documents.getState().setDocument(document({ direction: 'rtl' }));
    documents.getState().setDocument(null);
    expect(reader.getState()).toMatchObject({ hasDocument: false, pageCount: 0, direction: 'ltr' });
  });

  it('without a document the reader follows the interface language, with one it does not', () => {
    settings.getState().setUiLanguage('ar');
    expect(reader.getState().direction).toBe('rtl');
    settings.getState().setUiLanguage('en');
    expect(reader.getState().direction).toBe('ltr');
    documents.getState().setDocument(document({ direction: 'ltr' }));
    settings.getState().setUiLanguage('ar');
    expect(reader.getState().direction).toBe('ltr');
  });

  it('starts from what the stores already hold', () => {
    stop();
    documents.getState().setDocument(document({ pageCount: 9, direction: 'rtl' }));
    stop = startReaderSync(documents, reader, settings);
    expect(reader.getState()).toMatchObject({ pageCount: 9, direction: 'rtl' });
  });

  it('stopping detaches it', () => {
    stop();
    documents.getState().setDocument(document({ pageCount: 5 }));
    expect(reader.getState().hasDocument).toBe(false);
  });

  describe('the first spread when the diary is unveiled', () => {
    it('moves the reader to spread 1 as unveiling begins, so every presenter shows page 1', () => {
      documents.getState().setDocument(document({ pageCount: 30 }));
      expect(reader.getState().spread).toBe(0);
      enter('unveiling');
      expect(reader.getState().spread).toBe(1);
    });

    it('waits for the document when the phase changes first', () => {
      enter('unveiling');
      expect(reader.getState().spread).toBe(0);
      documents.getState().setDocument(document({ pageCount: 30 }));
      expect(reader.getState().spread).toBe(1);
    });

    it('only moves once per unveiling: a reader who went back to the bookplate is left alone', () => {
      documents.getState().setDocument(document({ pageCount: 30 }));
      enter('unveiling');
      reader.getState().goToSpread(0);
      documents.getState().setDocument(document({ pageCount: 30, filename: 'b.pdf' }));
      expect(reader.getState().spread).toBe(0);
    });

    it('does not carry a pending move into a later phase', () => {
      enter('unveiling');
      enter('closing');
      documents.getState().setDocument(document({ pageCount: 30 }));
      expect(reader.getState().spread).toBe(0);
    });

    it('puts the narrow reader on the first page of spread 1', () => {
      reader.getState().setNarrow(true);
      documents.getState().setDocument(document({ pageCount: 30, direction: 'rtl' }));
      enter('unveiling');
      expect(reader.getState()).toMatchObject({ spread: 1, focusSide: 'right' });
    });
  });

  it('"Read closely" ends when the manuscript gives way to a memory (the camera frames the spread there; paging must agree)', () => {
    documents.getState().setDocument(document());
    enter('manuscript');
    reader.getState().setClosely(true);
    expect(reader.getState().closely).toBe(true);
    enter('revealing');
    expect(reader.getState().closely).toBe(false);
    // and it is not switched on again by itself
    enter('memory');
    enter('manuscript');
    expect(reader.getState().closely).toBe(false);
  });
});
