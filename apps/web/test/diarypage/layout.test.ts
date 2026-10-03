import { describe, expect, it } from 'vitest';
import { forgetMeasures, layoutDiary, type ExchangeInput, type Measure } from '../../src/diarypage/layout';
import { INDENT, PAGE_WIDTH, ROWS, columnOf } from '../../src/diarypage/typography';
import { displayText, parseAnswer } from '../../src/ui/diary/format';
import { buildInkDoc, leadUnitCount } from '../../src/ui/diary/inkDoc';

/*
 * The diary's page layout is pure: a plain measure (every letter of the question hand 13 px, of the others 10) is enough to
 * check where the lines go, where a page ends and what stays together.
 */

const measure: Measure = (text, font) => text.length * (font.includes('27px') ? 13 : 10);
const BOOK = 'ltr' as const;
const COLUMN = columnOf(BOOK);

function exchange(
  id: string,
  question: string,
  answer: string | null,
  extra: Partial<ExchangeInput> = {},
): ExchangeInput {
  const doc = answer === null ? null : buildInkDoc(parseAnswer(displayText(answer, false), false));
  return {
    id,
    question,
    answer: doc,
    leadUnits: doc && extra.leadUnits === undefined ? leadUnitCount(doc, 40) : (extra.leadUnits ?? 0),
    answerFaces: 'latin',
    questionFaces: 'latin',
    notes: [],
    noteFaces: 'latin',
    ...extra,
  };
}

const lines = (layout: ReturnType<typeof layoutDiary>, role: 'question' | 'answer') =>
  layout.pages.flatMap((page) =>
    page.lines.filter((line) => line.role === role).map((line) => ({ page: page.index, line })),
  );

const words = (count: number) => Array.from({ length: count }, (_, i) => `word${String(i)}`).join(' ');

describe('layoutDiary', () => {
  it('starts an empty diary with the writing on the first row of one page', () => {
    const layout = layoutDiary([], { book: BOOK, measure });
    expect(layout.pageCount).toBe(1);
    expect(layout.next).toEqual({ page: 0, row: 0 });
    expect(layout.pages[0]?.lines).toEqual([]);
  });

  it('puts a short question on one row and leaves a row of space before the next', () => {
    const layout = layoutDiary([exchange('a', 'Who is Daphne?', null)], { book: BOOK, measure });
    expect(lines(layout, 'question')).toHaveLength(1);
    expect(layout.spans.a?.afterQuestion).toEqual({ page: 0, row: 1 });
    expect(layout.next).toEqual({ page: 1, row: 0 });
  });

  it('wraps at words so that no line is wider than the column', () => {
    const layout = layoutDiary([exchange('a', 'Q', words(60))], { book: BOOK, measure });
    const answer = lines(layout, 'answer');
    expect(answer.length).toBeGreaterThan(3);
    for (const { line } of answer) {
      const width = line.chunks.reduce((sum, chunk) => sum + chunk.width, 0);
      expect(width + line.indent).toBeLessThanOrEqual(COLUMN.width + 1e-6);
    }
    // Every word is somewhere, in order, and no word is split.
    const written = answer.map(({ line }) => line.chunks.map((chunk) => chunk.text).join('')).join(' ');
    expect(written.replace(/\s+/g, ' ')).toBe(words(60));
  });

  it('indents the first line of every paragraph after the first', () => {
    const layout = layoutDiary([exchange('a', 'Q', 'First paragraph here.\n\nSecond paragraph here.')], {
      book: BOOK,
      measure,
    });
    const answer = lines(layout, 'answer').map(({ line }) => line);
    expect(answer).toHaveLength(2);
    expect(answer[0]?.indent).toBe(0);
    expect(answer[1]?.indent).toBe(INDENT);
  });

  it('numbers the pieces of ink across lines so the pen can reveal them in order', () => {
    const layout = layoutDiary([exchange('a', 'Q', words(40))], { book: BOOK, measure });
    const answer = lines(layout, 'answer').map(({ line }) => line);
    let expected = 0;
    for (const line of answer) {
      expect(line.pieceFrom).toBe(expected);
      expect(line.pieceTo).toBeGreaterThan(line.pieceFrom);
      expected = line.pieceTo;
    }
    const doc = buildInkDoc(parseAnswer(words(40), false));
    expect(expected).toBe(doc.total);
    // A unit knows the piece it is; spaces ride with the piece before them.
    const units = answer.flatMap((line) => line.chunks.flatMap((chunk) => chunk.units));
    const ats = units.filter((unit) => unit.kind === 'glyph').map((unit) => unit.at);
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
    expect(ats.at(-1)).toBe(doc.total - 1);
  });

  it("writes the first sentence in the diary's hand and the rest in fair copy, never splitting a word", () => {
    const layout = layoutDiary(
      [exchange('a', 'Q', 'It began in spring. The rest of the story is told later on.', { leadUnits: 16 })],
      {
        book: BOOK,
        measure,
      },
    );
    const hands = lines(layout, 'answer').flatMap(({ line }) =>
      line.chunks.map((chunk) => [chunk.hand, chunk.text] as const),
    );
    expect(hands[0]?.[0]).toBe('lead');
    expect(hands[0]?.[1]?.trim()).toBe('It began in spring.');
    expect(hands.slice(1).every(([hand]) => hand === 'fair')).toBe(true);
  });

  it('flows a long answer onto the next page, one row at a time', () => {
    const layout = layoutDiary([exchange('a', 'Q', words(400))], { book: BOOK, measure });
    expect(layout.pageCount).toBeGreaterThan(1);
    for (const page of layout.pages) {
      const rows = page.lines.map((line) => line.row);
      expect(Math.max(...rows)).toBeLessThan(ROWS);
      expect(rows).toEqual([...rows].sort((a, b) => a - b));
      expect(new Set(rows).size).toBe(rows.length);
    }
    expect(layout.pages[0]?.lines).toHaveLength(ROWS);
  });

  it('one question and its answer to a page: every exchange begins on a fresh page, and so does the next question', () => {
    const layout = layoutDiary([exchange('a', 'Q', words(10)), exchange('b', 'Q2', 'An answer.')], {
      book: BOOK,
      measure,
    });
    expect(layout.spans.a?.questionFrom).toEqual({ page: 0, row: 0 });
    expect(layout.spans.b?.questionFrom).toEqual({ page: 1, row: 0 });
    expect(layout.next).toEqual({ page: 2, row: 0 });
    expect(layout.pageCount).toBe(3);
  });

  it('a long answer runs on to the next pages, and the next question is on the page after the last of them', () => {
    const layout = layoutDiary([exchange('a', 'Q', words(320))], { book: BOOK, measure });
    expect(layout.next.row).toBe(0);
    expect(layout.next.page).toBe((layout.spans.a?.lastPage ?? 0) + 1);
    expect(layout.pageCount).toBe(layout.next.page + 1);
  });

  it('sets the notes in the margin row after the answer, wrapping to a second row when they do not fit', () => {
    const notes = Array.from({ length: 7 }, (_, i) => ({
      key: `n${String(i)}`,
      label: `Pages ${String(i + 10)}-${String(i + 12)}`,
    }));
    const layout = layoutDiary([exchange('a', 'Q', 'A short answer.', { notes })], { book: BOOK, measure });
    const page = layout.pages[0];
    expect(page?.notes).toHaveLength(7);
    const rows = new Set(page?.notes.map((note) => note.row));
    expect(rows.size).toBeGreaterThan(1);
    const answerRow = lines(layout, 'answer')[0]?.line.row ?? 0;
    for (const note of page?.notes ?? []) {
      expect(note.row).toBeGreaterThan(answerRow);
      expect(note.x).toBeGreaterThanOrEqual(0);
      expect(note.x + note.width).toBeLessThanOrEqual(PAGE_WIDTH);
    }
  });

  it('flows notes of right-to-left script from the right edge of the column', () => {
    const layout = layoutDiary(
      [
        exchange('a', 'Q', 'A short answer.', {
          notes: [{ key: 'n', label: 'صفحة ١٢' }],
          noteFaces: 'arabic',
        }),
      ],
      { book: BOOK, measure },
    );
    const note = layout.pages[0]?.notes[0];
    expect(note?.dir).toBe('rtl');
    expect((note?.x ?? 0) + (note?.width ?? 0)).toBeLessThanOrEqual(COLUMN.right);
    expect((note?.x ?? 0) + (note?.width ?? 0)).toBeGreaterThan(COLUMN.right - INDENT * 3);
  });

  it('keeps the writing column off the binding margin, whichever side the book binds', () => {
    const rtlBook = columnOf('rtl');
    const ltrBook = columnOf('ltr');
    expect(ltrBook.left).toBeGreaterThan(rtlBook.left);
    expect(rtlBook.right).toBeLessThan(ltrBook.right);
    expect(ltrBook.width).toBe(rtlBook.width);
  });

  it('lays right-to-left text out right to left, with a left-to-right quotation as a run of its own', () => {
    const layout = layoutDiary(
      [
        exchange('a', 'ما هو العنوان؟', 'يقول النص "Hello World" في البداية.', {
          answerFaces: 'arabic',
          questionFaces: 'arabic',
        }),
      ],
      {
        book: BOOK,
        measure,
      },
    );
    const answer = lines(layout, 'answer')[0]?.line;
    expect(answer?.dir).toBe('rtl');
    const isolate = answer?.chunks.find((chunk) => chunk.isolate);
    expect(isolate?.dir).toBe('ltr');
    expect(isolate?.text).toContain('Hello World');
  });

  it('cuts a word that is wider than the column rather than let it spill off the page', () => {
    const long = 'x'.repeat(120);
    const layout = layoutDiary([exchange('a', 'Q', long)], { book: BOOK, measure });
    const answer = lines(layout, 'answer');
    expect(answer.length).toBeGreaterThan(1);
    expect(answer.map(({ line }) => line.chunks.map((chunk) => chunk.text).join('')).join('')).toBe(long);
  });

  it('honours the line breaks the writer made, blank ones too', () => {
    const layout = layoutDiary([exchange('a', 'one\n\ntwo', null)], { book: BOOK, measure });
    expect(lines(layout, 'question').map(({ line }) => line.row)).toEqual([0, 1, 2]);
  });

  it('reserves the rows the listening line and a notice need, after the question', () => {
    const listening = layoutDiary([exchange('a', 'Q', null, { listeningRows: 2 })], { book: BOOK, measure });
    expect(listening.spans.a?.tailFrom).toEqual({ page: 0, row: 1 });
    expect(listening.spans.a?.tailRows).toBe(2);
    expect(listening.next).toEqual({ page: 1, row: 0 });
    const failed = layoutDiary([exchange('a', 'Q', null, { noticeRows: 3 })], { book: BOOK, measure });
    expect(failed.spans.a?.tailRows).toBe(3);
  });

  it('puts the reply of a started answer where the listening line was', () => {
    const waiting = layoutDiary([exchange('a', 'Q', null, { listeningRows: 2 })], { book: BOOK, measure });
    const writing = layoutDiary([exchange('a', 'Q', 'Reply.', { listeningRows: 2 })], {
      book: BOOK,
      measure,
    });
    expect(lines(writing, 'answer')[0]?.line.row).toBe(waiting.spans.a?.tailFrom.row);
  });

  it('gives each line a key that stays the same as the exchange grows', () => {
    const before = layoutDiary([exchange('a', 'Q', words(30))], { book: BOOK, measure });
    const after = layoutDiary([exchange('a', 'Q', words(50))], { book: BOOK, measure });
    const keysBefore = before.pages[0]?.lines.map((line) => line.key) ?? [];
    expect(after.pages[0]?.lines.map((line) => line.key).slice(0, keysBefore.length)).toEqual(keysBefore);
  });

  it('flows several exchanges one after the other, a page each', () => {
    const layout = layoutDiary(
      [exchange('a', 'First?', 'One.'), exchange('b', 'Second?', 'Two.'), exchange('c', 'Third?', 'Three.')],
      { book: BOOK, measure },
    );
    const rowsOf = (id: string) => layout.spans[id]?.questionFrom;
    expect(rowsOf('a')).toEqual({ page: 0, row: 0 });
    expect(rowsOf('b')).toEqual({ page: 1, row: 0 });
    expect(rowsOf('c')).toEqual({ page: 2, row: 0 });
    expect(layout.next).toEqual({ page: 3, row: 0 });
  });

  it('measures a text in a font once, however often the page is laid out again, until the faces change', () => {
    let calls = 0;
    const counting: Measure = (text, font, direction) => {
      calls += 1;
      return measure(text, font, direction);
    };
    const input = [exchange('a', 'Who?', words(30))];
    layoutDiary(input, { book: BOOK, measure: counting });
    const first = calls;
    expect(first).toBeGreaterThan(10);
    layoutDiary(input, { book: BOOK, measure: counting });
    expect(calls).toBe(first);
    forgetMeasures(counting);
    layoutDiary(input, { book: BOOK, measure: counting });
    expect(calls).toBeGreaterThanOrEqual(first * 2);
  });

  it('heads the first page, and the first question is written on it under the heading; later ones go on the following pages', () => {
    const heading = { text: 'Heading text here', faces: 'latin' as const };
    const empty = layoutDiary([], { book: BOOK, measure, heading });
    expect(empty.pages[0]?.lines.every((line) => line.role === 'heading')).toBe(true);
    expect(empty.next.page).toBe(0);
    expect(empty.next.row).toBeGreaterThan(0);
    const layout = layoutDiary([exchange('a', 'First?', 'One.'), exchange('b', 'Second?', 'Two.')], {
      book: BOOK,
      measure,
      heading,
    });
    expect(layout.spans.a?.questionFrom.page).toBe(0);
    expect(layout.spans.a?.questionFrom.row).toBeGreaterThan(0);
    expect(layout.spans.b?.questionFrom).toEqual({ page: 1, row: 0 });
  });
});
