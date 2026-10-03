/*
 * The text of an answer, made fit to show. The model writes excerpt markers ([S1]) into its reply; the reader is shown the
 * pages they stand for as handwritten annotations instead (the citation chips), so the markers never appear in the text.
 * What is left is formatted by a whitelist that knows paragraphs, line breaks and **bold**, and nothing else: no HTML,
 * links or images are ever made from model output (global section I), and the result is only ever rendered as React text.
 */

const MARKER = /[ \t]*\[S\d{1,3}\]/gu;
/** The end of a text that may still become a marker: `[`, `[S`, `[S1`, `[S12`, `[S123` (at most six characters). */
const UNFINISHED_MARKER = /[ \t]*\[S?\d{0,3}$/u;

/**
 * The part of an answer to show now. Markers are removed (with the space before them). While the answer is still being
 * written (`streaming`), a marker that has not finished arriving is held back, so "[S" is never on the page for a moment,
 * and so is one trailing asterisk (it may be the first half of a bold marker).
 */
export function displayText(raw: string, streaming: boolean): string {
  let text = raw;
  if (streaming) {
    const unfinished = UNFINISHED_MARKER.exec(text);
    if (unfinished) text = text.slice(0, unfinished.index);
    else if (text.endsWith('*') && !text.endsWith('**')) text = text.slice(0, -1);
  }
  return text.replace(MARKER, '');
}

export type Inline = { kind: 'text'; text: string; bold: boolean } | { kind: 'br' };

export interface Paragraph {
  inlines: Inline[];
}

function inlinesOf(text: string, streaming: boolean): Inline[] {
  const parts = text.split('**');
  const unmatched = !streaming && (parts.length - 1) % 2 === 1;
  const inlines: Inline[] = [];
  let bold = false;
  parts.forEach((part, index) => {
    if (index > 0) bold = !bold;
    // An opener that never closes is text once the answer is final; while it is being written it is an open bold.
    if (unmatched && index === parts.length - 1) {
      const previous = inlines.at(-1);
      if (previous?.kind === 'text' && !previous.bold) previous.text += `**${part}`;
      else inlines.push({ kind: 'text', text: `**${part}`, bold: false });
      return;
    }
    if (part !== '') inlines.push({ kind: 'text', text: part, bold });
  });
  return inlines;
}

/** Paragraphs (blank-line separated), line breaks (single newlines) and bold; empty paragraphs are dropped. */
export function parseAnswer(text: string, streaming: boolean): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const blocks = text.trim().split(/\n[ \t]*\n+/u);
  blocks.forEach((block, blockIndex) => {
    const body = block.trim();
    if (body === '') return;
    const last = blockIndex === blocks.length - 1;
    // Bold never reaches across a paragraph: an unmatched marker belongs to its own paragraph (a line break does not end it).
    const inlines: Inline[] = [];
    for (const inline of inlinesOf(body, streaming && last)) {
      if (inline.kind === 'text' && inline.text.includes('\n')) {
        inline.text.split('\n').forEach((piece, index) => {
          if (index > 0) inlines.push({ kind: 'br' });
          if (piece !== '') inlines.push({ kind: 'text', text: piece, bold: inline.bold });
        });
      } else {
        inlines.push(inline);
      }
    }
    if (inlines.length > 0) paragraphs.push({ inlines });
  });
  return paragraphs;
}

/** The text a screen reader (or a copy) gets: paragraphs separated by a blank line, breaks by a newline. */
export function plainText(paragraphs: readonly Paragraph[]): string {
  return paragraphs
    .map((paragraph) =>
      paragraph.inlines.map((inline) => (inline.kind === 'br' ? '\n' : inline.text)).join(''),
    )
    .join('\n\n');
}
