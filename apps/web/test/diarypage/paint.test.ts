import { describe, expect, it } from 'vitest';
import { layoutDiary, type ExchangeInput, type Measure } from '../../src/diarypage/layout';
import { paintLine, paintNote, paintPageInk, paintRules } from '../../src/diarypage/paint';
import { PAGE_WIDTH, ROWS, baselineOf, columnOf } from '../../src/diarypage/typography';
import { displayText, parseAnswer } from '../../src/ui/diary/format';
import { buildInkDoc } from '../../src/ui/diary/inkDoc';
import { recordingCanvas } from '../helpers/recordingCanvas';

const measure: Measure = (text) => text.length * 10;

function exchange(over: Partial<ExchangeInput> & { answerText?: string }): ExchangeInput {
  const doc = over.answerText ? buildInkDoc(parseAnswer(displayText(over.answerText, false), false)) : null;
  return {
    id: 'a',
    question: 'Who?',
    answer: doc,
    leadUnits: 0,
    answerFaces: 'latin',
    questionFaces: 'latin',
    notes: [],
    noteFaces: 'latin',
    ...over,
  };
}

function draw(fn: (ctx: CanvasRenderingContext2D) => void) {
  const rec = recordingCanvas();
  const canvas = rec.create(PAGE_WIDTH, 728);
  const ctx = canvas.getContext('2d')!;
  fn(ctx);
  return rec.calls;
}

describe('painting a diary page', () => {
  it('rules every row of the page, and one hairline down the margin of the binding', () => {
    const calls = draw((ctx) => {
      paintRules(ctx, PAGE_WIDTH, 'ltr');
    });
    expect(calls.filter((call) => call.name === 'stroke')).toHaveLength(ROWS + 1);
  });

  it('writes each line from the edge it starts at: the left of the column for left-to-right, the right for right-to-left', () => {
    const layout = layoutDiary([exchange({ question: 'مرحبا' })], { book: 'ltr', measure });
    const line = layout.pages[0]?.lines[0];
    expect(line?.dir).toBe('rtl');
    const calls = draw((ctx) => {
      if (line) paintLine(ctx, line, 'ltr');
    });
    const text = calls.filter((call) => call.name === 'fillText');
    expect(text.length).toBeGreaterThan(0);
    const [, x, y] = text[0]?.args as [string, number, number];
    const width = line?.chunks.reduce((sum, chunk) => sum + chunk.width, 0) ?? 0;
    expect(x).toBeCloseTo(columnOf('ltr').right - width, 5);
    expect(y).toBe(baselineOf(0));

    const latin = layoutDiary([exchange({ question: 'Who' })], { book: 'ltr', measure });
    const latinCalls = draw((ctx) => {
      const first = latin.pages[0]?.lines[0];
      if (first) paintLine(ctx, first, 'ltr');
    });
    const [, lx] = latinCalls.find((call) => call.name === 'fillText')?.args as [string, number];
    expect(lx).toBe(columnOf('ltr').left);
  });

  it('sets the direction of every run it draws: a left-to-right quotation inside right-to-left text is drawn left to right', () => {
    const layout = layoutDiary(
      [exchange({ answerText: 'يقول النص Hello World هنا', answerFaces: 'arabic' })],
      {
        book: 'ltr',
        measure,
      },
    );
    const directions = draw((ctx) => {
      for (const line of layout.pages[0]?.lines ?? []) paintLine(ctx, line, 'ltr');
    }).filter((call) => call.name.startsWith('direction:'));
    expect(directions.some((call) => call.name === 'direction:ltr')).toBe(true);
    expect(directions.some((call) => call.name === 'direction:rtl')).toBe(true);
  });

  it('draws every line of a page and every note, and leaves the context as it found it', () => {
    const layout = layoutDiary(
      [exchange({ answerText: 'A short answer.', notes: [{ key: 'n', label: 'Page 12' }] })],
      { book: 'ltr', measure },
    );
    const page = layout.pages[0];
    const calls = draw((ctx) => {
      if (page) paintPageInk(ctx, PAGE_WIDTH, page, 'ltr');
    });
    const names = calls.map((call) => call.name);
    expect(names.filter((name) => name === 'save').length).toBe(
      names.filter((name) => name === 'restore').length,
    );
    const texts = calls.filter((call) => call.name === 'fillText').map((call) => call.args[0]);
    expect(texts).toContain('Page 12');
    expect(texts.join('')).toContain('A short answer.');
  });

  it('draws a note a little off the line, underlined with a dash, and a consulted one dotted', () => {
    const note = {
      key: 'n',
      exchange: 'a',
      label: 'Page 7',
      kind: 'cited' as const,
      row: 3,
      x: 90,
      width: 80,
      faces: 'latin' as const,
      dir: 'ltr' as const,
    };
    const cited = draw((ctx) => {
      paintNote(ctx, note);
    });
    expect(cited.some((call) => call.name === 'rotate')).toBe(true);
    expect(cited.find((call) => call.name === 'setLineDash')?.args[0]).toEqual([4, 3]);
    const consulted = draw((ctx) => {
      paintNote(ctx, { ...note, kind: 'consulted' });
    });
    expect(consulted.find((call) => call.name === 'setLineDash')?.args[0]).toEqual([1, 3]);
  });

  it('scales the design page to the texture: the same lines at any resolution', () => {
    const layout = layoutDiary([exchange({ answerText: 'Hello.' })], { book: 'ltr', measure });
    const page = layout.pages[0];
    const scaleCalls = (width: number) =>
      draw((ctx) => {
        if (page) paintPageInk(ctx, width, page, 'ltr');
      }).filter((call) => call.name === 'scale');
    expect(scaleCalls(1040)[0]?.args).toEqual([2, 2]);
    expect(scaleCalls(520)[0]?.args).toEqual([1, 1]);
  });
});
