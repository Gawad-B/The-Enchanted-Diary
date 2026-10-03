import type { Direction } from '@enchanted/shared';
import type { Ctx2D } from '../book/paperTexture';
import type { DiaryPageLayout, LayoutChunk, NotePlace, PageLine } from './layout';
import {
  PAGE_HEIGHT,
  PAGE_WIDTH,
  PITCH,
  ROWS,
  RULE_IN_ROW,
  baselineOf,
  columnOf,
  fontOf,
  rowTop,
} from './typography';

/*
 * A diary page drawn on a canvas: the ruled sheet, and the ink of the lines that were written on it. Everything is in design
 * px (520 by 728) under a scale, so the same layout that the DOM surface shows is drawn here; the colours are those of dried ink.
 */

/** Dried ink: the reader's question a faint trace, the diary's first sentence its own dark hand, the rest the fair copy. */
export const DRIED = {
  question: { color: '#3b2c26', alpha: 0.5 },
  lead: { color: '#2a1410', alpha: 0.94 },
  fair: { color: '#4a3220', alpha: 0.92 },
  note: { color: '#5a1a22', alpha: 0.88 },
} as const;
const RULE_COLOR = 'rgba(96, 62, 36, 0.2)';
const NOTE_TILT = -0.014;

/** The faint rules the lines of the page sit on, and a hairline at the margin of the binding. */
export function paintRules(ctx: Ctx2D, width: number, book: Direction): void {
  const scale = width / PAGE_WIDTH;
  const column = columnOf(book);
  ctx.save();
  ctx.scale(scale, scale);
  ctx.strokeStyle = RULE_COLOR;
  ctx.lineWidth = 0.9;
  ctx.lineCap = 'round';
  for (let row = 0; row < ROWS; row += 1) {
    const y = rowTop(row) + RULE_IN_ROW;
    ctx.beginPath();
    ctx.moveTo(column.left - 8, y);
    ctx.lineTo(column.right + 8, y);
    ctx.stroke();
  }
  // A single line down the margin of the binding, as on a ruled diary.
  const edge = book === 'ltr' ? column.left - 16 : column.right + 16;
  ctx.strokeStyle = 'rgba(120, 50, 40, 0.16)';
  ctx.beginPath();
  ctx.moveTo(edge, rowTop(0) - 12);
  ctx.lineTo(edge, rowTop(ROWS) - PITCH + RULE_IN_ROW + 8);
  ctx.stroke();
  ctx.restore();
}

/** Writes a text as ink that has soaked into the paper a little: a soft bleed under the stroke, then the stroke. */
function inkText(ctx: Ctx2D, text: string, x: number, y: number, color: string, alpha: number): void {
  ctx.shadowColor = 'rgba(52, 28, 14, 0.5)';
  ctx.shadowBlur = 1.4;
  ctx.globalAlpha = alpha * 0.5;
  ctx.fillText(text, x, y);
  ctx.shadowBlur = 0;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function paintChunk(
  ctx: Ctx2D,
  chunk: LayoutChunk,
  left: number,
  baseline: number,
  role: PageLine['role'],
): void {
  const style = role === 'question' ? DRIED.question : chunk.hand === 'lead' ? DRIED.lead : DRIED.fair;
  ctx.font = fontOf(chunk.hand, chunk.faces, chunk.bold);
  ctx.direction = chunk.dir;
  ctx.fillStyle = style.color;
  inkText(ctx, chunk.text, left, baseline, style.color, style.alpha);
}

/** One line of writing, from the edge it starts at in its own direction. */
export function paintLine(ctx: Ctx2D, line: PageLine, book: Direction): void {
  const column = columnOf(book);
  const baseline = baselineOf(line.row);
  let x = line.dir === 'ltr' ? column.left + line.indent : column.right - line.indent;
  for (const chunk of line.chunks) {
    if (line.dir === 'ltr') {
      paintChunk(ctx, chunk, x, baseline, line.role);
      x += chunk.width;
    } else {
      x -= chunk.width;
      paintChunk(ctx, chunk, x, baseline, line.role);
    }
  }
}

/** A note in the margin: the page it points to, in a pencilled hand a little off the line, underlined with a dash. */
export function paintNote(ctx: Ctx2D, note: NotePlace): void {
  const baseline = baselineOf(note.row);
  ctx.save();
  ctx.translate(note.x, baseline);
  ctx.rotate(NOTE_TILT);
  ctx.font = fontOf('note', note.faces);
  ctx.direction = note.dir;
  ctx.textAlign = 'left';
  ctx.fillStyle = DRIED.note.color;
  inkText(ctx, note.label, 11, 0, DRIED.note.color, DRIED.note.alpha);
  ctx.strokeStyle = note.kind === 'consulted' ? 'rgba(42, 20, 16, 0.5)' : 'rgba(90, 26, 34, 0.55)';
  ctx.lineWidth = 1;
  ctx.setLineDash(note.kind === 'consulted' ? [1, 3] : [4, 3]);
  ctx.beginPath();
  ctx.moveTo(4, 6);
  ctx.lineTo(note.width - 4, 6);
  ctx.stroke();
  ctx.restore();
}

/** All the ink of a page. The context is left as it was found. */
export function paintPageInk(ctx: Ctx2D, width: number, page: DiaryPageLayout, book: Direction): void {
  const scale = width / PAGE_WIDTH;
  ctx.save();
  ctx.scale(scale, scale);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  for (const line of page.lines) {
    ctx.save();
    paintLine(ctx, line, book);
    ctx.restore();
  }
  for (const note of page.notes) paintNote(ctx, note);
  ctx.restore();
}

/** The height a canvas of this width has to have for a page. */
export const heightFor = (width: number): number => Math.round((width * PAGE_HEIGHT) / PAGE_WIDTH);
