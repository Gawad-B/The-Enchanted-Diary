import { dominantDirection, normalizeForMatch, type Direction } from '@enchanted/shared';
import { chunkDocument, type Chunk, type ChunkingOptions, type ChunkPageInput } from '../chunking/chunker.js';
import {
  MIN_LETTERS_FOR_DETECTION,
  detectLanguage,
  documentDirection,
  primaryLanguage,
  summarizeLanguages,
  type LanguageShare,
} from '../language/detect.js';
import { HEADING_MAX_CHARS, HEADING_MAX_LINES } from '../pdf/layout.js';
import type { OutlineEntry } from '../pdf/outline.js';
import type { ExtractedPage, TextBlock } from '../pdf/types.js';

/** What the caller knows about how far a page's text can be trusted (see `PageAssessment.lowTextQuality`). */
export interface PageEvidenceFlags {
  /**
   * The page's text is garbled (lost glyphs, mojibake): it is kept for search, but it says nothing about the
   * document's language, direction or sections.
   */
  garbled?: boolean;
  /** The direction the page's fonts suggest when its text cannot (an Arabic font gives 'rtl'). */
  directionHint?: Direction;
}

/** The part of an extracted page that analysis and chunking need (no raw items, no per-item geometry). */
export type AnalyzablePage = Pick<ExtractedPage, 'pageNumber' | 'text' | 'blocks'> & PageEvidenceFlags;

export interface PageAnalysis {
  pageNumber: number;
  language: string;
  direction: Direction;
}

export interface SectionEntry {
  title: string;
  page: number;
}

export interface Analysis {
  pages: PageAnalysis[];
  languages: LanguageShare[];
  primaryLanguage: string;
  direction: Direction;
  sections: SectionEntry[];
  chunks: Chunk[];
}

/** An outline of at least this many resolvable entries replaces the heuristic headings (review item I9). */
const MIN_OUTLINE_ENTRIES = 2;

const letters = (text: string): number => text.match(/\p{L}/gu)?.length ?? 0;

/**
 * Outline entries decide the sections: the matching heading block is confirmed, the rest are demoted. A block that
 * merely STARTS with an outline title (a run-in heading: "1.2 Background The house was ...") is too long to be a
 * heading: it is not promoted, but the section still starts there.
 */
function applyOutline(pages: readonly AnalyzablePage[], outline: readonly OutlineEntry[]): SectionEntry[] {
  for (const page of pages) for (const block of page.blocks) block.isHeading = false;
  const sections: SectionEntry[] = [];
  for (const entry of outline) {
    const page = pages.find((candidate) => candidate.pageNumber === entry.pageNumber);
    if (page === undefined) continue;
    const wanted = normalizeForMatch(entry.title);
    const block: TextBlock | undefined = page.blocks.find((candidate) => {
      const text = normalizeForMatch(candidate.text);
      return (
        text !== '' &&
        wanted !== '' &&
        (text === wanted || text.startsWith(wanted) || wanted.startsWith(text))
      );
    });
    if (block !== undefined && !block.isHeading) {
      const short = block.text.length <= HEADING_MAX_CHARS && block.lines.length <= HEADING_MAX_LINES;
      block.isHeading = short;
      block.headingTitle = entry.title; // for a long block this is the title of the section that starts in it
    } else if (block === undefined) {
      const first = page.blocks.find((candidate) => !candidate.isHeading);
      if (first !== undefined && first.headingTitle === undefined) first.headingTitle = entry.title;
    }
    sections.push({ title: entry.title, page: entry.pageNumber });
  }
  return sections;
}

/**
 * Language, direction, sections and chunks of a document, from its extracted pages. Pure: runs in the
 * ingestion worker (and in tests). Blocks get their language from their own text where there is enough of it, so a
 * bilingual page chunks into chunks of the right language.
 */
export function analyzePages(
  pages: readonly AnalyzablePage[],
  options: { chunking: ChunkingOptions; outline?: readonly OutlineEntry[] },
  onProgress?: (
    step: 'analyzing' | 'chunking',
    completed: number,
    total: number,
    direction?: Direction,
  ) => void,
): Analysis {
  const evidence = pages.filter((page) => page.garbled !== true);
  const pageAnalyses: PageAnalysis[] = [];
  pages.forEach((page, index) => {
    if (page.garbled === true) {
      // Garbled text is no evidence: no language, no headings (their titles would be mojibake), the direction its
      // fonts suggest (settled below when the document's own direction is known).
      pageAnalyses.push({
        pageNumber: page.pageNumber,
        language: 'und',
        direction: page.directionHint ?? 'ltr',
      });
      for (const block of page.blocks) block.isHeading = false;
    } else {
      const guess = detectLanguage(page.text);
      pageAnalyses.push({
        pageNumber: page.pageNumber,
        language: guess.code,
        direction: page.text.trim() === '' ? 'ltr' : dominantDirection(page.text),
      });
      for (const block of page.blocks) {
        if (letters(block.text) >= MIN_LETTERS_FOR_DETECTION)
          block.language = detectLanguage(block.text).code;
      }
    }
    onProgress?.('analyzing', index + 1, pages.length);
  });

  const languages = summarizeLanguages(evidence);
  const hints = pages.flatMap((page) =>
    page.garbled === true && page.directionHint !== undefined ? [page.directionHint] : [],
  );
  const direction: Direction =
    evidence.length > 0
      ? documentDirection(languages, evidence.map((page) => page.text).join('\n'))
      : hints.filter((hint) => hint === 'rtl').length * 2 >= hints.length && hints.length > 0
        ? 'rtl'
        : 'ltr';
  pages.forEach((page, index) => {
    const analysis = pageAnalyses[index];
    if (page.garbled === true && analysis !== undefined) analysis.direction = page.directionHint ?? direction;
  });
  // The direction is known now: tell the client before the (longer) chunking so it can lay the closed book out.
  onProgress?.('analyzing', pages.length, pages.length, direction);

  const outline = options.outline ?? [];
  let sections: SectionEntry[];
  if (outline.length >= MIN_OUTLINE_ENTRIES) {
    sections = applyOutline(pages, outline);
  } else {
    sections = pages.flatMap((page) =>
      page.blocks
        .filter((block) => block.isHeading)
        .map((block) => ({
          title: (block.headingTitle ?? block.text).replace(/\s+/gu, ' ').trim(),
          page: page.pageNumber,
        })),
    );
  }
  sections = sections.filter((section, index) => section.title !== sections[index - 1]?.title);

  const chunkPages = toChunkPages(
    pages,
    (pageNumber) => pageAnalyses.find((analysis) => analysis.pageNumber === pageNumber)?.language ?? 'und',
  );
  const garbledPages = new Map(
    pages.map((page, index) => [page.pageNumber, page.garbled === true ? pageAnalyses[index] : undefined]),
  );
  const chunks = chunkDocument(chunkPages, options.chunking).map((chunk) => {
    // Chunks of garbled pages take the direction of their page, not the one the garbage text happens to look like.
    const garbled = garbledPages.get(chunk.pageStart);
    return garbled === undefined ? chunk : { ...chunk, direction: garbled.direction };
  });
  onProgress?.('chunking', pages.length, pages.length);

  return {
    pages: pageAnalyses,
    languages,
    primaryLanguage: primaryLanguage(languages),
    direction,
    sections,
    chunks,
  };
}

/** The pages as the chunker wants them: blocks with their line geometry, languages per page (and per block if known). */
export function toChunkPages(
  pages: readonly AnalyzablePage[],
  languageOf: (pageNumber: number) => string,
): ChunkPageInput[] {
  return pages.map((page) => ({
    pageNumber: page.pageNumber,
    text: page.text,
    language: languageOf(page.pageNumber),
    blocks: page.blocks.map((block) => ({
      text: block.text,
      charStart: block.charStart,
      charEnd: block.charEnd,
      isHeading: block.isHeading,
      headingTitle: block.headingTitle,
      sectionStart: block.isHeading ? undefined : block.headingTitle,
      language: block.language,
      lines: block.lines,
    })),
  }));
}
