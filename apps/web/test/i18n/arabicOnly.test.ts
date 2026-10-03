import { describe, expect, it } from 'vitest';
import { STRINGS } from '../../src/i18n/strings';

/*
 * "Arabic means Arabic" (global section T.2): nothing in the Arabic interface is in English. The one thing a Latin letter may
 * still be is a proper name or a format that has no Arabic spelling in use: "PDF" (and the file extension ".pdf"). A document's
 * own words (a quotation, a file name) are not copy: they are the reader's, and are never in these tables.
 */

/** The Latin-script words the Arabic copy may carry. */
const ALLOWED = new Set(['PDF', 'pdf']);

function leaves(value: unknown, path: string, out: { path: string; text: string }[]): void {
  if (typeof value === 'string') out.push({ path, text: value });
  else if (Array.isArray(value))
    value.forEach((entry, index) => leaves(entry, `${path}[${String(index)}]`, out));
  else if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) leaves(entry, `${path}.${key}`, out);
  }
}

/** The Latin-script words of a line of copy, leaving out its {placeholders} (they are filled by the interface language's own formatting). */
export function latinWords(text: string): string[] {
  return text.replace(/\{[^}]*\}/gu, '').match(/\p{Script=Latin}+/gu) ?? [];
}

describe('the Arabic copy has no English in it', () => {
  const all: { path: string; text: string }[] = [];
  leaves(STRINGS.ar, 'ar', all);

  it('has copy to check (the scan is not empty)', () => {
    expect(all.length).toBeGreaterThan(150);
  });

  it('no line has a Latin-script word outside the allow-list (PDF)', () => {
    const offenders = all
      .map(({ path, text }) => ({ path, words: latinWords(text).filter((word) => !ALLOWED.has(word)) }))
      .filter(({ words }) => words.length > 0)
      .map(({ path, words }) => `${path}: ${words.join(' ')}`);
    expect(offenders).toEqual([]);
  });

  it("the diary's own in-world lines, the sources, and the page's controls are Arabic", () => {
    const ar = STRINGS.ar;
    const lines = [
      ...ar.preUpload,
      ar.ask.notFound,
      ar.ask.notCertain,
      ar.ask.passages,
      ar.ask.nothingToShow,
      ar.ask.truncated,
      ar.ask.retry,
      ar.citation.page,
      ar.citation.pages,
      ar.citation.show,
      ar.citation.showRange,
      ar.citation.showConsulted,
      ar.diary.writeInDiary,
      ar.diary.leave,
      ar.diary.earlierPage,
      ar.diary.laterPage,
      ar.diary.pageNumber,
      ar.diary.returnToDiary,
      ar.diary.clear,
      ar.diary.clearAsk,
      ar.diary.clearConfirm,
    ];
    for (const line of lines) {
      expect(latinWords(line)).toEqual([]);
      expect(line).toMatch(/\p{Script=Arabic}/u);
    }
  });

  it('the scan sees a stray English word (it is not blind)', () => {
    expect(latinWords('اكتب Write إلى {name} المذكّرة')).toEqual(['Write']);
    expect(latinWords('صفحة {n}')).toEqual([]);
  });
});
