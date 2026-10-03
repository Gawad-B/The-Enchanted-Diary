import { describe, expect, it } from 'vitest';
import { diffUnits, groupRuns, segmentInk, wordsOf, type InkUnit } from '../../src/ui/diary/segment';

const texts = (units: InkUnit[]): string[] => units.map((unit) => unit.text);
const joined = (units: InkUnit[]): string => units.map((unit) => unit.text).join('');

describe('segmentInk: what lands on the page as one piece of ink', () => {
  it('splits Latin text into graphemes (each glyph lands on its own)', () => {
    const units = segmentInk('Who?');
    expect(texts(units)).toEqual(['W', 'h', 'o', '?']);
    expect(units.every((unit) => unit.kind !== 'word')).toBe(true);
  });

  it('keeps a combining sequence together as one grapheme', () => {
    expect(texts(segmentInk('café'))).toEqual(['c', 'a', 'f', 'é']);
  });

  it('marks spaces and line breaks so they never animate', () => {
    const units = segmentInk('a b\nc');
    expect(units.map((unit) => unit.kind)).toEqual(['glyph', 'space', 'glyph', 'break', 'glyph']);
  });

  it('keeps every Arabic word whole: no span ever splits an Arabic word', () => {
    const text = 'من أسّس المدرسة الكبيرة؟';
    const units = segmentInk(text);
    const words = units.filter((unit) => unit.kind === 'word').map((unit) => unit.text);
    expect(words).toEqual(['من', 'أسّس', 'المدرسة', 'الكبيرة']);
    // no unit other than a whole word contains an Arabic letter
    for (const unit of units.filter((u) => u.kind !== 'word')) {
      expect(/\p{Script=Arabic}/u.test(unit.text), JSON.stringify(unit.text)).toBe(false);
    }
    expect(joined(units)).toBe(text);
  });

  it('keeps an Arabic word with its diacritics and tatweel in one unit', () => {
    const units = segmentInk('الســلام عَلَيْكُمْ');
    expect(units.filter((unit) => unit.kind === 'word').map((unit) => unit.text)).toEqual([
      'الســلام',
      'عَلَيْكُمْ',
    ]);
  });

  it('uses whole words for scripts that join or have no spaces (Devanagari, Thai, Han)', () => {
    for (const text of ['नमस्ते दुनिया', 'สวัสดีชาวโลก', '你好世界']) {
      const units = segmentInk(text);
      expect(
        units.some((unit) => unit.kind === 'word'),
        text,
      ).toBe(true);
      expect(joined(units)).toBe(text);
    }
  });

  it('treats Greek and Cyrillic like Latin: graphemes', () => {
    expect(texts(segmentInk('Привет'))).toHaveLength(6);
    expect(texts(segmentInk('Γειά'))).toHaveLength(4);
  });

  it('mixed text: Latin graphemes inside, Arabic words whole, and the text is never changed', () => {
    const text = 'اقرأ Tips Hindawi ثم 2023';
    const units = segmentInk(text);
    expect(joined(units)).toBe(text);
    expect(units.filter((unit) => unit.kind === 'word').map((unit) => unit.text)).toEqual(['اقرأ', 'ثم']);
    expect(units.find((unit) => unit.text === 'T')?.kind).toBe('glyph');
  });

  it('is lossless for any text (emoji, ZWJ sequences, surrogate pairs)', () => {
    const text = 'a 👩‍👩‍👧 𝒳 b';
    expect(joined(segmentInk(text))).toBe(text);
  });

  it('empty text has no units', () => {
    expect(segmentInk('')).toEqual([]);
  });
});

describe('wordsOf: the pieces of a question that sink one after another', () => {
  it('lists the words in reading order (the order of the text, which is the reading order in Arabic too)', () => {
    expect(wordsOf('Who founded it?')).toEqual(['Who', 'founded', 'it?']);
    expect(wordsOf('من أسّس المدرسة؟')).toEqual(['من', 'أسّس', 'المدرسة؟']);
  });

  it('ignores extra white space', () => {
    expect(wordsOf('  a \n\n b  ')).toEqual(['a', 'b']);
  });
});

describe('groupRuns: left-to-right runs inside right-to-left text are isolated', () => {
  it('wraps a Latin run inside Arabic text in one isolated run, and leaves Arabic words outside', () => {
    const units = segmentInk('اقرأ Tips Hindawi ثم');
    const runs = groupRuns(units, 'rtl');
    const isolated = runs.filter((run) => run.isolate);
    expect(isolated).toHaveLength(1);
    expect(joined(isolated[0]?.units ?? [])).toBe('Tips Hindawi');
    expect(runs.map((run) => joined(run.units)).join('')).toBe('اقرأ Tips Hindawi ثم');
  });

  it('does not isolate anything in left-to-right text', () => {
    const runs = groupRuns(segmentInk('Tips Hindawi'), 'ltr');
    expect(runs.every((run) => !run.isolate)).toBe(true);
  });

  it('with symmetric, an Arabic quotation inside left-to-right text is isolated, quotes and all staying outside', () => {
    const units = segmentInk('The text says: "مكتبة الأوراق القديمة." Then more.');
    const runs = groupRuns(units, 'ltr', { symmetric: true });
    const isolated = runs.filter((run) => run.isolate);
    expect(isolated).toHaveLength(1);
    expect(joined(isolated[0]?.units ?? [])).toBe('مكتبة الأوراق القديمة');
    expect(runs.map((run) => joined(run.units)).join('')).toBe(
      'The text says: "مكتبة الأوراق القديمة." Then more.',
    );
    // and without it, left-to-right text is left alone
    expect(groupRuns(units, 'ltr').every((run) => !run.isolate)).toBe(true);
  });

  it('a digit run counts as left-to-right and is isolated too', () => {
    const runs = groupRuns(segmentInk('سنة 2023 م'), 'rtl');
    expect(runs.filter((run) => run.isolate).map((run) => joined(run.units))).toEqual(['2023']);
  });
});

describe('diffUnits: stable identity for the units that did not change', () => {
  const build = (text: string, previous: { id: number; unit: InkUnit }[] = [], start = 0) => {
    let next = start;
    return diffUnits(previous, segmentInk(text), () => (next += 1));
  };

  it('typing at the end keeps every earlier unit (so only the new glyph lands)', () => {
    const first = build('Who');
    const second = build('Whom', first, 100);
    expect(second.slice(0, 3).map((entry) => entry.id)).toEqual(first.map((entry) => entry.id));
    expect(second[3]?.id).toBeGreaterThan(100);
  });

  it('typing in the middle keeps the units before and after it', () => {
    const first = build('Wo');
    const second = build('Who', first.slice(), 100); // inserts "h" between W and o... as W h o
    expect(second.map((entry) => entry.unit.text)).toEqual(['W', 'h', 'o']);
    expect(second[0]?.id).toBe(first[0]?.id);
    expect(second[2]?.id).toBe(first[1]?.id);
    expect(second[1]?.id).toBeGreaterThan(100);
  });

  it('deleting keeps the rest', () => {
    const first = build('Whom');
    const second = build('Who', first, 100);
    expect(second.map((entry) => entry.id)).toEqual(first.slice(0, 3).map((entry) => entry.id));
  });

  it('replacing everything gives every unit a new identity', () => {
    const first = build('abc');
    const second = build('xyz', first, 100);
    expect(second.every((entry) => entry.id > 100)).toBe(true);
  });
});
