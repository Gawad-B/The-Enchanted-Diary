import type { ChunkOutlineRow } from '../db/repositories/search.js';
import { truncateAtBoundary } from './retrieve.js';

/**
 * Which chunks of a manuscript represent it, for the reveal's essence and key points and for the questions about the document
 * as a whole. A document that fits in `max` chunks is read whole. Otherwise the chunks are spread over the PAGES: the first
 * chunk always, then one for each of `max` evenly spaced target pages, preferring a section start close to the target (a
 * heading is a better opening than the middle of a section) and never one that is already taken. Sections alone decide
 * nothing: a book with two headings in its first pages, or with headings that only start at the end, is still read
 * from beginning to end. Slots left over (several targets fall in one long chunk) are filled evenly from the chunks not yet
 * chosen. The result is in document order.
 */
export function selectRepresentativeChunks(
  outline: readonly ChunkOutlineRow[],
  max: number,
): ChunkOutlineRow[] {
  if (outline.length <= max) return [...outline];
  const first = outline[0];
  if (first === undefined || max <= 0) return [];
  const chosen = new Map<string, ChunkOutlineRow>([[first.id, first]]);
  const firstPage = first.pageStart;
  const lastPage = Math.max(...outline.map((row) => row.pageEnd), firstPage);
  const slots = Math.max(max, 2);
  const span = (lastPage - firstPage) / (slots - 1);

  const starts: ChunkOutlineRow[] = [];
  let previous: string | null = null;
  for (const row of outline) {
    if (row.sectionTitle !== null && row.sectionTitle !== previous) starts.push(row);
    previous = row.sectionTitle;
  }
  const distance = (row: ChunkOutlineRow, page: number): number =>
    page >= row.pageStart && page <= row.pageEnd
      ? 0
      : Math.min(Math.abs(row.pageStart - page), Math.abs(row.pageEnd - page));
  const nearest = (rows: readonly ChunkOutlineRow[], page: number): ChunkOutlineRow | undefined =>
    rows
      .filter((row) => !chosen.has(row.id))
      .reduce<ChunkOutlineRow | undefined>(
        (best, row) => (best === undefined || distance(row, page) < distance(best, page) ? row : best),
        undefined,
      );

  for (let slot = 1; slot < slots && chosen.size < max; slot += 1) {
    const target = Math.round(firstPage + slot * span);
    const heading = nearest(starts, target);
    const pick =
      heading !== undefined && distance(heading, target) <= Math.max(1, span / 2)
        ? heading
        : nearest(outline, target);
    if (pick !== undefined) chosen.set(pick.id, pick);
  }
  if (chosen.size < max) {
    const rest = outline.filter((row) => !chosen.has(row.id));
    for (const row of evenlySpaced(rest, max - chosen.size)) chosen.set(row.id, row);
  }
  return [...chosen.values()].sort((a, b) => a.chunkIndex - b.chunkIndex);
}

/** `max` items spread evenly over `items`, always including the first and the last. */
export function evenlySpaced<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  if (max <= 1) return items.slice(0, 1);
  const picked = new Set<number>();
  for (let slot = 0; slot < max; slot += 1) picked.add(Math.round((slot * (items.length - 1)) / (max - 1)));
  return [...picked]
    .sort((a, b) => a - b)
    .flatMap((index) => {
      const item = items[index];
      return item === undefined ? [] : [item];
    });
}

/**
 * Fits the texts into `budget` characters by giving each the same share when they do not fit whole: every one is cut
 * at a sentence or word edge. Texts that fit are returned unchanged.
 */
export function fitEvenly(texts: readonly string[], budget: number): { text: string; truncated: boolean }[] {
  const total = texts.reduce((sum, text) => sum + text.length, 0);
  if (total <= budget) return texts.map((text) => ({ text, truncated: false }));
  const share = Math.max(1, Math.floor(budget / Math.max(1, texts.length)));
  return texts.map((text) => ({ text: truncateAtBoundary(text, share), truncated: text.length > share }));
}
