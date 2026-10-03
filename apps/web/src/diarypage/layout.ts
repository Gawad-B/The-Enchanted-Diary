import type { Direction } from '@enchanted/shared';
import { firstStrongDirection } from '../ui/diary/language';
import { weighs, type InkDoc } from '../ui/diary/inkDoc';
import { groupRuns, segmentInk, type InkUnit, type UnitKind } from '../ui/diary/segment';
import { INDENT, PAGE_WIDTH, ROWS, columnOf, fontOf, type FaceSet, type Hand } from './typography';

/*
 * The diary's pages, laid out: where every line of every exchange goes. Pure (the measure of a text is injected), so the DOM
 * surface (the page the reader writes on) and the texture of the 3D page (the page seen from afar, and when the book is turned)
 * are drawn from the same lines. The exchanges flow through the pages one row at a time on a ruled grid; a question keeps company
 * with the first lines of its answer; the answer's sources are written as notes in the margin of its last page.
 */

/** The width of a text in a font, in px (the canvas measures it; tests give a plain rule). */
export type Measure = (text: string, font: string, direction: Direction) => number;

export interface LayoutUnit {
  text: string;
  kind: UnitKind;
  /** The piece of ink this unit is (or, for white space, follows): the pen has written it when this is below the count. -1 before any. */
  at: number;
  /** Which word of its block this belongs to (-1 for white space): the question's words sink one after another. */
  word: number;
}

export interface LayoutChunk {
  units: LayoutUnit[];
  text: string;
  hand: Hand;
  faces: FaceSet;
  bold: boolean;
  /** The direction the chunk is written in (a left-to-right quotation inside right-to-left text is its own run). */
  dir: Direction;
  isolate: boolean;
  width: number;
}

export interface PageLine {
  key: string;
  exchange: string;
  role: 'question' | 'answer' | 'heading';
  row: number;
  /** The direction of the paragraph: where the line starts. */
  dir: Direction;
  /** How far in from the start edge the line begins. */
  indent: number;
  chunks: LayoutChunk[];
  /** The first piece of ink in the line, and one past the last (pieces of the answer only). */
  pieceFrom: number;
  pieceTo: number;
}

export interface NotePlace {
  key: string;
  exchange: string;
  label: string;
  /** `cited`: the answer rests on the page. `consulted`: the diary read it but did not cite it (drawn dotted). */
  kind: 'cited' | 'consulted';
  row: number;
  /** The left edge and the width of the note's box on the page. */
  x: number;
  width: number;
  faces: FaceSet;
  dir: Direction;
}

export interface DiaryPageLayout {
  index: number;
  lines: PageLine[];
  notes: NotePlace[];
}

export interface RowRef {
  page: number;
  row: number;
}

export interface ExchangeSpan {
  /** The row of the question's first line. */
  questionFrom: RowRef;
  /** Where the question ends: the row after its last line. */
  afterQuestion: RowRef;
  /** Where a line that is not writing (the diary is listening; the answer could not come) goes: after the answer and its notes. */
  tailFrom: RowRef;
  /** Rows the tail takes. */
  tailRows: number;
  /** The row after the exchange's last row (the tail included). */
  end: RowRef;
  firstPage: number;
  lastPage: number;
}

export interface NoteInput {
  key: string;
  label: string;
  kind?: 'cited' | 'consulted';
}

export interface ExchangeInput {
  id: string;
  question: string;
  /** The answer's pieces of ink, or null (nothing to show yet, or no answer). */
  answer: InkDoc | null;
  /** The first this-many pieces of the answer are in the diary's hand. */
  leadUnits: number;
  /** The script of the answer's face set (decided from its text). */
  answerFaces: FaceSet;
  questionFaces: FaceSet;
  notes: readonly NoteInput[];
  noteFaces: FaceSet;
  /** Rows to keep free after the question for a notice (an answer that could not come), 0 when none. */
  noticeRows?: number;
  /** Rows to keep free after the question for the line that says the diary is listening, 0 when none. */
  listeningRows?: number;
}

export interface DiaryLayout {
  pages: DiaryPageLayout[];
  spans: Record<string, ExchangeSpan>;
  /** Where the next question is written: after the last exchange, on a fresh page when there is no room. */
  next: RowRef;
  /** The number of pages that hold anything (the page the next question is written on included). */
  pageCount: number;
}

/** The rows a question keeps with the start of its answer. */
const KEEP_WITH_ANSWER = 2;
const NOTE_PADDING = 22;
const NOTE_GAP = 14;

export function oppositeOf(direction: Direction): Direction {
  return direction === 'ltr' ? 'rtl' : 'ltr';
}

interface Token {
  units: InkUnit[];
  atFrom: number;
  word: number;
  bold: boolean;
  space: boolean;
  /** A forced end of line (a line break the writer made). */
  hard: boolean;
}

interface Paragraph {
  tokens: Token[];
  dir: Direction;
  indent: number;
}

/** Splits units into tokens (a word with the marks around it, a run of white space, a break) and gives each its pieces. */
function tokenize(
  groups: readonly { units: readonly InkUnit[]; bold: boolean }[],
  counters: { piece: number; word: number },
): Token[] {
  const tokens: Token[] = [];
  for (const group of groups) {
    let current: Token | null = null;
    for (const unit of group.units) {
      const space = unit.kind === 'space';
      const hard = unit.kind === 'break';
      if (hard) {
        tokens.push({
          units: [unit],
          atFrom: counters.piece - 1,
          word: -1,
          bold: group.bold,
          space: false,
          hard: true,
        });
        current = null;
        continue;
      }
      // The explicit null test is what narrows `current` for the lines below.
      // eslint-disable-next-line @typescript-eslint/prefer-optional-chain
      if (current === null || current.space !== space) {
        current = {
          units: [],
          atFrom: space ? counters.piece - 1 : counters.piece,
          word: space ? -1 : counters.word,
          bold: group.bold,
          space,
          hard: false,
        };
        if (!space) counters.word += 1;
        tokens.push(current);
      }
      current.units.push(unit);
      if (weighs(unit)) counters.piece += 1;
    }
  }
  return tokens;
}

function textOf(units: readonly InkUnit[]): string {
  return units.map((unit) => unit.text).join('');
}

interface Style {
  faces: FaceSet;
  /** The hand of a token (the lead is the first sentence of an answer). */
  hand: (token: Token) => Hand;
}

interface Built {
  lines: { chunks: LayoutChunk[]; dir: Direction; indent: number; pieceFrom: number; pieceTo: number }[];
}

/** What was measured, per measure: a text in a font is measured once for as long as the faces do not change. */
const measured = new WeakMap<Measure, Map<string, number>>();
/** The most widths kept for a measure (a long conversation has a few thousand different words). */
const MEASURED_MAX = 20000;

/** Forgets what a measure has measured: the faces it measured with have changed (more fonts loaded). */
export function forgetMeasures(measure: Measure): void {
  measured.delete(measure);
}

function cachedMeasure(measure: Measure): Measure {
  let cache = measured.get(measure);
  if (!cache) {
    cache = new Map();
    measured.set(measure, cache);
  }
  const widths = cache;
  return (text, font, direction) => {
    const key = `${font}|${direction}|${text}`;
    const known = widths.get(key);
    if (known !== undefined) return known;
    const width = measure(text, font, direction);
    if (widths.size >= MEASURED_MAX) widths.clear();
    widths.set(key, width);
    return width;
  };
}

/** Lays one paragraph's tokens out in lines of at most `width` px (the first starts `indent` in), with a word longer than a line cut. */
function breakLines(paragraph: Paragraph, style: Style, width: number, measure: Measure): Built {
  const out: Built['lines'] = [];
  let line: Token[] = [];
  let lineWidth = 0;
  let indent = paragraph.indent;
  let first = true;
  const flush = (): void => {
    while (line.length > 0 && line[line.length - 1]?.space) line.pop();
    const content = line.filter((token) => !token.hard);
    const dir = paragraph.dir;
    out.push({
      chunks: chunksOf(content, dir, style, measure),
      dir,
      indent,
      pieceFrom: pieceRange(line).from,
      pieceTo: pieceRange(line).to,
    });
    line = [];
    lineWidth = 0;
    if (first) first = false;
    indent = 0;
  };
  const room = (): number => width - (first ? paragraph.indent : 0);
  const widthOf = (token: Token): number => {
    const hand = style.hand(token);
    return measure(textOf(token.units), fontOf(hand, style.faces, token.bold), paragraph.dir);
  };
  for (const token of paragraph.tokens) {
    if (token.hard) {
      line.push(token);
      flush();
      continue;
    }
    if (token.space) {
      if (line.length > 0) {
        line.push(token);
        lineWidth += widthOf(token);
      }
      continue;
    }
    const w = widthOf(token);
    if (line.length > 0 && lineWidth + w > room()) {
      flush();
    }
    if (w > room() && token.units.length > 1 && token.units.every((unit) => unit.kind === 'glyph')) {
      // A word wider than the line (a long address): cut where the line is full.
      let rest = token.units;
      while (rest.length > 0) {
        let count = 1;
        const font = fontOf(style.hand(token), style.faces, token.bold);
        while (
          count < rest.length &&
          measure(textOf(rest.slice(0, count + 1)), font, paragraph.dir) <= room() - lineWidth
        )
          count += 1;
        const part: Token = { ...token, units: rest.slice(0, count) };
        line.push(part);
        lineWidth += widthOf(part);
        rest = rest.slice(count);
        if (rest.length > 0) flush();
      }
      continue;
    }
    line.push(token);
    lineWidth += w;
  }
  if (line.some((token) => !token.space) || out.length === 0) flush();
  return { lines: out };
}

function pieceRange(tokens: readonly Token[]): { from: number; to: number } {
  let from = Number.POSITIVE_INFINITY;
  let to = -1;
  for (const token of tokens) {
    if (token.space || token.hard) continue;
    let piece = token.atFrom;
    for (const unit of token.units) {
      if (weighs(unit)) {
        from = Math.min(from, piece);
        to = Math.max(to, piece);
        piece += 1;
      }
    }
  }
  return to < 0 ? { from: 0, to: 0 } : { from, to: to + 1 };
}

/** The chunks of a line: runs of one hand and weight in one direction, each measured as it will be drawn. */
function chunksOf(tokens: readonly Token[], dir: Direction, style: Style, measure: Measure): LayoutChunk[] {
  interface Flat {
    unit: InkUnit;
    layout: LayoutUnit;
    hand: Hand;
    bold: boolean;
  }
  const flat: Flat[] = [];
  for (const token of tokens) {
    const hand = style.hand(token);
    let piece = token.atFrom;
    for (const unit of token.units) {
      const at = weighs(unit) ? piece : token.space ? token.atFrom : piece;
      if (weighs(unit)) piece += 1;
      flat.push({
        unit,
        layout: { text: unit.text, kind: unit.kind, at, word: token.word },
        hand,
        bold: token.bold,
      });
    }
  }
  const runs = groupRuns(
    flat.map((entry) => entry.unit),
    dir,
    { symmetric: true },
  );
  const chunks: LayoutChunk[] = [];
  let cursor = 0;
  for (const run of runs) {
    const members = flat.slice(cursor, cursor + run.units.length);
    cursor += run.units.length;
    let current: { hand: Hand; bold: boolean; members: Flat[] } | null = null;
    const emit = (): void => {
      if (!current) return;
      const text = current.members.map((entry) => entry.unit.text).join('');
      const chunkDir = run.isolate ? oppositeOf(dir) : dir;
      chunks.push({
        units: current.members.map((entry) => entry.layout),
        text,
        hand: current.hand,
        faces: style.faces,
        bold: current.bold,
        dir: chunkDir,
        isolate: run.isolate,
        width: measure(text, fontOf(current.hand, style.faces, current.bold), chunkDir),
      });
      current = null;
    };
    for (const member of members) {
      // eslint-disable-next-line @typescript-eslint/prefer-optional-chain
      if (current === null || current.hand !== member.hand || current.bold !== member.bold) {
        emit();
        current = { hand: member.hand, bold: member.bold, members: [] };
      }
      current.members.push(member);
    }
    emit();
  }
  return chunks;
}

interface NoteBox {
  key: string;
  label: string;
  kind: 'cited' | 'consulted';
  offset: number;
  width: number;
  row: number;
}

/** The rows of a row of notes: each note's box, flowing from the start edge of the note's script. */
function placeNotes(
  notes: readonly NoteInput[],
  faces: FaceSet,
  layout: Direction,
  measure: Measure,
): { rows: number; boxes: NoteBox[]; dir: Direction } {
  const column = columnOf(layout);
  const dir: Direction = faces === 'arabic' ? 'rtl' : 'ltr';
  const font = fontOf('note', faces);
  const boxes: NoteBox[] = [];
  let offset = INDENT * 2;
  let row = 0;
  for (const note of notes) {
    const width = measure(note.label, font, dir) + NOTE_PADDING;
    if (offset > INDENT * 2 && offset + width > column.width) {
      row += 1;
      offset = INDENT * 2;
    }
    boxes.push({ key: note.key, label: note.label, kind: note.kind ?? 'cited', offset, width, row });
    offset += width + NOTE_GAP;
  }
  return { rows: notes.length === 0 ? 0 : row + 1, boxes, dir };
}

export interface LayoutOptions {
  /** The direction the book is laid out in: which side of the page is the binding. */
  book: Direction;
  measure: Measure;
  /** What the first page is headed with (it is the page the first question is written on). */
  heading?: { text: string; faces: FaceSet };
}

/** Lays the exchanges out on the diary's pages. */
export function layoutDiary(exchanges: readonly ExchangeInput[], options: LayoutOptions): DiaryLayout {
  const measure = cachedMeasure(options.measure);
  const column = columnOf(options.book);
  const pages: DiaryPageLayout[] = [{ index: 0, lines: [], notes: [] }];
  const spans: Record<string, ExchangeSpan> = {};
  let page = 0;
  let row = 0;
  const pageAt = (index: number): DiaryPageLayout => {
    for (let at = pages.length; at <= index; at += 1) pages.push({ index: at, lines: [], notes: [] });
    const found = pages[index];
    if (!found) throw new RangeError(`no page ${String(index)}`);
    return found;
  };
  const ensure = (rows: number): void => {
    if (row > 0 && row + rows > ROWS) {
      page += 1;
      row = 0;
    }
  };
  const place = (exchange: string, role: PageLine['role'], built: Built, count: { n: number }): void => {
    for (const line of built.lines) {
      if (row >= ROWS) {
        page += 1;
        row = 0;
      }
      pageAt(page).lines.push({
        key: `${exchange}:${role}:${String(count.n)}`,
        exchange,
        role,
        row,
        dir: line.dir,
        indent: line.indent,
        chunks: line.chunks,
        pieceFrom: line.pieceFrom,
        pieceTo: line.pieceTo,
      });
      count.n += 1;
      row += 1;
    }
  };

  if (options.heading) {
    const paragraph: Paragraph = {
      tokens: tokenize([{ units: segmentInk(options.heading.text), bold: false }], { piece: 0, word: 0 }),
      dir: firstStrongDirection(options.heading.text),
      indent: 0,
    };
    const built = breakLines(
      paragraph,
      { faces: options.heading.faces, hand: () => 'lead' },
      column.width,
      measure,
    );
    place('heading', 'heading', built, { n: 0 });
    // A row of space under it: the first question begins here.
    row += 1;
  }
  for (const [index, exchange] of exchanges.entries()) {
    // One question and its answer to a page: every exchange begins on a fresh page.
    if (row > 0 && !(index === 0 && options.heading)) {
      page += 1;
      row = 0;
    }
    const questionUnits = segmentInk(exchange.question);
    const questionCounters = { piece: 0, word: 0 };
    const questionParagraph: Paragraph = {
      tokens: tokenize([{ units: questionUnits, bold: false }], questionCounters),
      dir: firstStrongDirection(exchange.question),
      indent: 0,
    };
    // A reply with no question of its own (the flyleaf's scripted lines) has no rows of question.
    const question: Built =
      exchange.question === ''
        ? { lines: [] }
        : breakLines(
            questionParagraph,
            { faces: exchange.questionFaces, hand: () => 'question' },
            column.width,
            measure,
          );
    const answer: Built = { lines: [] };
    if (exchange.answer) {
      const counters = { piece: 0, word: 0 };
      const answerStyle: Style = {
        faces: exchange.answerFaces,
        // White space is in the hand of the piece before it, so a sentence in the diary's hand is one stretch of it.
        hand: (token) => (token.atFrom < exchange.leadUnits ? 'lead' : 'fair'),
      };
      exchange.answer.paragraphs.forEach((paragraph, index) => {
        const groups = paragraph.items.map((item) =>
          item.kind === 'br'
            ? { units: [{ text: '\n', kind: 'break' as const, script: 'neutral' as const }], bold: false }
            : { units: item.units, bold: item.bold },
        );
        const tokens = tokenize(groups, counters);
        const text = textOf(groups.flatMap((group) => group.units));
        const built = breakLines(
          { tokens, dir: firstStrongDirection(text), indent: index === 0 ? 0 : INDENT },
          answerStyle,
          column.width,
          measure,
        );
        answer.lines.push(...built.lines);
      });
    }
    // The tail: a notice when the answer could not come, or the line that says the diary is listening while nothing has been written.
    const tailRows =
      (exchange.noticeRows ?? 0) + (answer.lines.length === 0 ? (exchange.listeningRows ?? 0) : 0);
    ensure(question.lines.length + Math.min(Math.max(answer.lines.length, tailRows), KEEP_WITH_ANSWER));
    const questionFrom: RowRef = { page, row };
    const counter = { n: 0 };
    place(exchange.id, 'question', question, counter);
    const afterQuestion: RowRef = row >= ROWS ? { page: page + 1, row: 0 } : { page, row };
    place(exchange.id, 'answer', answer, counter);
    const notes = placeNotes(exchange.notes, exchange.noteFaces, options.book, measure);
    if (notes.rows > 0) {
      ensure(notes.rows);
      if (row >= ROWS) {
        page += 1;
        row = 0;
      }
      const target = pageAt(page);
      for (const box of notes.boxes) {
        const x = notes.dir === 'ltr' ? column.left + box.offset : column.right - box.offset - box.width;
        target.notes.push({
          key: box.key,
          exchange: exchange.id,
          label: box.label,
          kind: box.kind,
          row: row + box.row,
          x: Math.min(Math.max(x, 0), PAGE_WIDTH - box.width),
          width: box.width,
          faces: exchange.noteFaces,
          dir: notes.dir,
        });
      }
      row += notes.rows;
    }
    if (tailRows > 0) ensure(tailRows);
    const tailFrom: RowRef = { page, row };
    row += tailRows;
    const end: RowRef = row >= ROWS ? { page: page + 1, row: 0 } : { page, row };
    spans[exchange.id] = {
      questionFrom,
      afterQuestion,
      tailFrom,
      tailRows,
      end,
      firstPage: questionFrom.page,
      lastPage: page,
    };
    // A row of space between exchanges.
    row += 1;
  }
  // The next question is written on a fresh page (the first one, on the first).
  if (row > 0 && exchanges.length > 0) {
    page += 1;
    row = 0;
  }
  const next: RowRef = { page, row };
  pageAt(page);
  return { pages, spans, next, pageCount: pages.length };
}

/** The rows an unwritten page offers (for tests and the surface). */
export const PAGE_ROWS = ROWS;
