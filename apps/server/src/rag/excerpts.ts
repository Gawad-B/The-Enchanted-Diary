import type { Citation } from '@enchanted/shared';
import type { ChunkRow } from '../db/repositories/chunks.js';
import { SNIPPET_MAX_CHARS } from './constants.js';
import { displayText, flagInstructionLike, sanitizeExcerptText, type ExcerptView } from './injection.js';
import { truncateAtBoundary, type RetrievedChunk } from './retrieve.js';

/** An excerpt as the model sees it, together with the chunk it came from (for citations and storage). */
export interface PreparedExcerpt extends ExcerptView {
  chunk: ChunkRow;
  /** How the chunk was found; absent for chunks the reveal picked without a search. */
  retrieved?: RetrievedChunk;
}

export interface ExcerptSource {
  chunk: ChunkRow;
  /** The part of the chunk to show the model (all of it, or its start). */
  text: string;
  retrieved?: RetrievedChunk;
}

/**
 * Numbers the chunks S1, S2, ... in the order given (best first), sanitises their text and flags the ones that read
 * like orders. A file name or section title that reads like orders flags the excerpts it labels.
 */
export function prepareExcerpts(sources: readonly ExcerptSource[], documentName: string): PreparedExcerpt[] {
  const nameFlagged = flagInstructionLike(documentName);
  return sources.map((source, index) => ({
    id: `S${String(index + 1)}`,
    chunk: source.chunk,
    ...(source.retrieved === undefined ? {} : { retrieved: source.retrieved }),
    pageStart: source.chunk.page_start,
    pageEnd: source.chunk.page_end,
    sectionTitle: source.chunk.section_title,
    language: source.chunk.language,
    text: sanitizeExcerptText(source.text),
    flagged:
      nameFlagged ||
      flagInstructionLike(source.chunk.content) ||
      (source.chunk.section_title !== null && flagInstructionLike(source.chunk.section_title)),
  }));
}

/**
 * A short piece of the chunk for the citation card (the visitor reads it, not a model): invisible characters out, at most
 * SNIPPET_MAX_CHARS characters, one line of text. Not escaped: it is plain text for the UI, which renders text as text.
 */
export function snippetOf(content: string): string {
  return truncateAtBoundary(displayText(content), SNIPPET_MAX_CHARS - 1);
}

/** The citation of an excerpt: its page range, a snippet, and the highlight rectangles of the chunk on each page. */
export function citationOf(excerpt: PreparedExcerpt): Citation {
  const { chunk } = excerpt;
  return {
    marker: excerpt.id,
    chunkId: chunk.id,
    pageStart: chunk.page_start,
    pageEnd: chunk.page_end,
    sectionTitle: chunk.section_title === null ? null : displayText(chunk.section_title).slice(0, 160),
    snippet: snippetOf(chunk.content),
    language: chunk.language,
    direction: chunk.direction,
    highlights: chunk.highlights.map((highlight) => ({ page: highlight.page, rects: highlight.rects })),
  };
}

/** The pages the retrieval touched, each once, ascending: `citations.consulted` and the `retrieval` event. */
export function pagesOf(excerpts: readonly PreparedExcerpt[]): number[] {
  const pages = new Set<number>();
  for (const { chunk } of excerpts) {
    for (let page = chunk.page_start; page <= chunk.page_end; page += 1) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}
