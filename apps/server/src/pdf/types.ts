import type { Direction, NormalizedRect } from '@enchanted/shared';

/** A pdf.js text item after cleaning, positioned in viewport space (rotation applied, origin top-left, y down). */
export interface PositionedItem {
  /** NUL/FFFD removed, NFKC, marks and bidi controls stripped. Characters inside are in logical order. */
  text: string;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  /** y of the baseline. */
  baseline: number;
  fontSize: number;
  fontName: string;
  /** Known only once the font names of the page have been looked up; otherwise false. */
  bold: boolean;
  /** False for text that is not horizontal on the displayed page (rotated lines are handled one item at a time). */
  horizontal: boolean;
}

export interface TextLine {
  /** Logical text of the line, normalised. */
  text: string;
  direction: Direction;
  baseline: number;
  fontSize: number;
  bold: boolean;
  /** Bounding box in viewport space. */
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  /** The same box as fractions of the page, origin top-left. */
  rect: NormalizedRect;
  /** Offsets into the page text (set when the page text is built). */
  charStart: number;
  charEnd: number;
  /** A wide gap inside the line: a table row (never a heading). */
  tabular: boolean;
}

export interface TextBlock {
  index: number;
  /** Lines joined with "\n" (line-break hyphenation undone). */
  text: string;
  /** Where the block sits in the page text; `text` equals `pageText.slice(charStart, charEnd)`. */
  charStart: number;
  charEnd: number;
  lines: TextLine[];
  isHeading: boolean;
  /** Set when the heading comes from the PDF outline: the outline's title. */
  headingTitle?: string;
  fontSize: number;
  bold: boolean;
  direction: Direction;
  /** One rectangle per line, fractions of the page. */
  rects: NormalizedRect[];
  /** Set by the analysis step (language detection per block). */
  language?: string;
}

export interface FontStats {
  /** The font size with the most characters: the size of the body text. */
  bodyFontSize: number;
  /** The page's normal line spacing: a low quantile of the baseline-to-baseline distances between consecutive lines. */
  medianLeading: number;
  sizes: { size: number; chars: number }[];
  /** Real font names (not pdf.js's internal ids); empty when they were not looked up for this page. */
  fontNames: string[];
}

/** Evidence about how trustworthy the extracted text of a page is (global section N, review item I8). */
export interface PageQuality {
  /** Characters pdf.js returned, before cleaning. */
  rawChars: number;
  /** U+0000 and U+FFFD among them: glyphs pdf.js could not map to Unicode. */
  unmappedChars: number;
  unmappedRatio: number;
  /** Share of U+FFFD, private-use characters and unmapped glyphs among all characters. */
  garbageRatio: number;
  /** Share of the cleaned text in U+00C0-U+00FF, C0/C1 controls, private use and U+FFFD (mojibake). */
  mojibakeRatio: number;
  /** ASCII digits and symbols sitting between two Arabic letters (what LibreOffice does to ligature glyphs). */
  sandwichedAscii: number;
  /** Letters of Arabic script as a share of all letters. */
  arabicLetterShare: number;
  /** Letters spread over several unrelated scripts: the signature of a font without a usable ToUnicode map. */
  scriptScatter: boolean;
  /** An Arabic-looking font name was seen on the page (only looked up when the text looks suspicious). */
  arabicFontNames: boolean;
}

export interface ExtractedPage {
  pageNumber: number;
  /** Size of the displayed page in points (rotation applied). */
  width: number;
  height: number;
  rotation: number;
  items: PositionedItem[];
  /** Every line of every block, in reading order. */
  lines: TextLine[];
  blocks: TextBlock[];
  /** Blocks joined by a blank line. */
  text: string;
  /** Non-whitespace characters of `text`. */
  charCount: number;
  /** Share of the page covered by images (0..1); only measured for pages with little text, otherwise 0. */
  imageCoverage: number;
  /**
   * How many filled vector paths the page draws (see `vectorFillCount`): hundreds on a page whose text was turned into
   * outlines, none on a blank one. Only measured for pages with little text, like `imageCoverage`; otherwise 0.
   */
  vectorPaths: number;
  /** Images the extraction limit refused to decode (only noticed where the operator list is built). */
  removedImages: number;
  fontStats: FontStats;
  quality: PageQuality;
}
