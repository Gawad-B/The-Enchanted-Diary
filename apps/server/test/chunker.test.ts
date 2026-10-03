import { describe, expect, it } from 'vitest';
import {
  chunkDocument,
  enforceTokenWindow,
  type Chunk,
  type ChunkBlockInput,
  type ChunkLineInput,
  type ChunkPageInput,
  type ChunkingOptions,
} from '../src/chunking/chunker.js';
import { estimateTokens } from '../src/chunking/tokens.js';
import { buildOcrPageText } from '../src/ocr/ocr-page.js';

const OPTIONS: ChunkingOptions = { targetChars: 400, maxChars: 600, minChars: 100, overlapChars: 120 };

interface BlockSpec {
  text: string;
  heading?: boolean;
}

/** A page whose text is the blocks joined by a blank line, with one line rectangle per 60 characters. */
function page(pageNumber: number, specs: readonly (BlockSpec | string)[], language = 'en'): ChunkPageInput {
  const blocks: ChunkBlockInput[] = [];
  let text = '';
  specs.forEach((spec, index) => {
    const { text: blockText, heading = false } = typeof spec === 'string' ? { text: spec } : spec;
    if (index > 0) text += '\n\n';
    const charStart = text.length;
    text += blockText;
    const lines: ChunkLineInput[] = [];
    for (let offset = 0; offset < blockText.length; offset += 60) {
      const row: number = blocks.length + lines.length;
      lines.push({
        charStart: charStart + offset,
        charEnd: charStart + Math.min(blockText.length, offset + 60),
        rect: { x: 0.1, y: Math.min(0.9, 0.05 + row * 0.01), w: 0.8, h: 0.01 },
      });
    }
    blocks.push({
      text: blockText,
      charStart,
      charEnd: charStart + blockText.length,
      isHeading: heading,
      lines,
    });
  });
  return { pageNumber, text, language, blocks };
}

const sentence = (n: number): string =>
  `This is sentence number ${String(n)} of the long paragraph and it says something plain.`;
const paragraph = (from: number, count: number): string =>
  Array.from({ length: count }, (_, i) => sentence(from + i)).join(' ');

/** Own text of a single-page chunk: the part of its content after the overlap. */
const own = (chunk: Chunk): string => chunk.content.slice(chunk.overlapChars);

describe('chunkDocument', () => {
  it('starts a new chunk at every heading and carries the section title across chunks and pages', () => {
    const pages = [
      page(1, [{ text: 'The Founding', heading: true }, paragraph(1, 3), paragraph(4, 3)]),
      page(2, [paragraph(7, 3), { text: 'The Lost Archive', heading: true }, paragraph(10, 2)]),
    ];
    const chunks = chunkDocument(pages, { ...OPTIONS, overlapChars: 0 });
    expect(chunks.map((chunk) => chunk.sectionTitle)).toEqual(
      chunks.map((chunk) =>
        chunk.content.startsWith('The Lost Archive') ||
        (chunk.pageStart === 2 && chunk.content.includes('number 10'))
          ? 'The Lost Archive'
          : 'The Founding',
      ),
    );
    const archive = chunks.filter((chunk) => chunk.sectionTitle === 'The Lost Archive');
    expect(archive[0]?.content.startsWith('The Lost Archive')).toBe(true);
    expect(chunks[0]?.content.startsWith('The Founding\n\nThis is sentence number 1')).toBe(true);
    // The Founding's text on page 2 is still in section "The Founding".
    const carried = chunks.find((chunk) => chunk.pageStart === 2 && chunk.content.includes('number 7 '));
    expect(carried?.sectionTitle).toBe('The Founding');
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, i) => i));
  });

  it('packs whole blocks up to the target size and starts a new chunk rather than exceed it', () => {
    const blocks = Array.from(
      { length: 20 },
      (_, i) => `Block ${String(i)}: ${'filler words '.repeat(7).trim()}.`,
    );
    const chunks = chunkDocument([page(1, blocks)], { ...OPTIONS, overlapChars: 0 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(OPTIONS.targetChars);
      // Only whole blocks: every chunk starts at a block start and ends at a block end.
      expect(chunk.content.startsWith('Block ')).toBe(true);
      expect(chunk.content.endsWith('words.')).toBe(true);
    }
    expect(chunks.slice(0, -1).every((chunk) => chunk.content.length > OPTIONS.targetChars - 110)).toBe(true);
  });

  it('never exceeds the maximum, splits an oversized block at sentence boundaries and loses no text', () => {
    const text = paragraph(1, 40); // about 3,400 characters in one block
    const chunks = chunkDocument([page(1, [text])], { ...OPTIONS, overlapChars: 0 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(OPTIONS.maxChars);
      expect(chunk.content.endsWith('plain.')).toBe(true); // cut at a sentence end
      expect(chunk.content.startsWith('This is sentence number')).toBe(true);
    }
    expect(chunks.map((chunk) => own(chunk)).join(' ')).toBe(text);
  });

  it('keeps offsets exact: the page text between the offsets is the chunk text without its overlap', () => {
    const pages = [page(1, ['Heading', paragraph(1, 12), paragraph(13, 12)]), page(2, [paragraph(25, 14)])];
    for (const chunk of chunkDocument(pages, OPTIONS)) {
      expect(chunk.pageStart).toBe(chunk.pageEnd);
      const source = pages[chunk.pageStart - 1]?.text ?? '';
      expect(source.slice(chunk.charStart, chunk.charEnd)).toBe(own(chunk));
      const [highlight] = chunk.highlights;
      expect(chunk.highlights).toHaveLength(1);
      expect(highlight).toMatchObject({
        page: chunk.pageStart,
        charStart: chunk.charStart,
        charEnd: chunk.charEnd,
      });
    }
  });

  it('prepends whole trailing sentences of the previous chunk in the same section, and 0 disables it', () => {
    const pages = [page(1, [paragraph(1, 30)])];
    const withOverlap = chunkDocument(pages, OPTIONS);
    const without = chunkDocument(pages, { ...OPTIONS, overlapChars: 0 });
    expect(without.every((chunk) => chunk.overlapChars === 0)).toBe(true);
    expect(withOverlap[0]?.overlapChars).toBe(0);
    for (let i = 1; i < withOverlap.length; i += 1) {
      const chunk = withOverlap[i]!;
      const previous = withOverlap[i - 1]!;
      expect(chunk.overlapChars).toBeGreaterThan(0);
      expect(chunk.overlapChars).toBeLessThanOrEqual(OPTIONS.overlapChars + 2);
      const overlap = chunk.content.slice(0, chunk.overlapChars).trim();
      expect(own(previous).endsWith(overlap)).toBe(true);
      expect(overlap.startsWith('This is sentence number')).toBe(true); // whole sentences
      expect(chunk.content.length).toBeLessThanOrEqual(OPTIONS.maxChars);
    }
    // Overlap is configurable.
    const bigger = chunkDocument(pages, { ...OPTIONS, overlapChars: 250 });
    expect(bigger[1]?.overlapChars ?? 0).toBeGreaterThan(withOverlap[1]?.overlapChars ?? 0);
  });

  it('does not overlap across a section boundary', () => {
    const pages = [page(1, [paragraph(1, 5), { text: 'Next Section', heading: true }, paragraph(6, 5)])];
    const chunks = chunkDocument(pages, OPTIONS);
    const first = chunks.find((chunk) => chunk.sectionTitle === 'Next Section');
    expect(first?.overlapChars).toBe(0);
  });

  it('keeps chunks inside their page, but lets one paragraph run over a page break', () => {
    const runOver = [
      page(1, [paragraph(1, 3), 'and this paragraph stops in the middle of a sentence without punctuation']),
      page(2, ['and goes on here to the end of the thought.', paragraph(20, 3)]),
    ];
    const chunks = chunkDocument(runOver, { ...OPTIONS, overlapChars: 0, targetChars: 1000, maxChars: 1500 });
    const crossing = chunks.filter((chunk) => chunk.pageStart !== chunk.pageEnd);
    expect(crossing).toHaveLength(1);
    expect(crossing[0]?.pageStart).toBe(1);
    expect(crossing[0]?.pageEnd).toBe(2);
    expect(crossing[0]?.content).toContain('without punctuation\n\nand goes on here');
    expect(crossing[0]?.content).not.toContain('number 20 ');
    expect(crossing[0]?.highlights.map((h) => h.page)).toEqual([1, 2]);
    expect(crossing[0]?.charStart).toBe(0);
    expect(crossing[0]?.charEnd).toBe(runOver[1]?.blocks[0]?.charEnd ?? 0);

    const finished = [page(1, [paragraph(1, 3)]), page(2, ['A new paragraph on the next page.'])];
    expect(chunkDocument(finished, OPTIONS).every((chunk) => chunk.pageStart === chunk.pageEnd)).toBe(true);

    const headingFollows = [
      page(1, ['text that has no end']),
      page(2, [{ text: 'A New Heading', heading: true }, 'Body text under it.']),
    ];
    expect(chunkDocument(headingFollows, OPTIONS).every((chunk) => chunk.pageStart === chunk.pageEnd)).toBe(
      true,
    );
  });

  describe('a page that ends on a page number or a footer (what OCR transcribes)', () => {
    const OPTS = { ...OPTIONS, overlapChars: 0, targetChars: 1000, maxChars: 1500 };
    const lastLines = [
      '12',
      '- 12 -',
      'Page 12',
      'page 12 of 40',
      '12 / 40',
      'صفحة ١٢',
      '١٢',
      'The Blue Ledger | 12',
      '14 — Saltmarsh',
    ];

    it.each(lastLines)('does not join the next page when the last line is "%s"', (footer) => {
      const pages = [
        page(1, [paragraph(1, 3), 'the surveyors left the harbour without a word', footer]),
        page(2, ['The next page starts a new paragraph that has nothing to do with it', paragraph(10, 2)]),
      ];
      const chunks = chunkDocument(pages, OPTS);
      expect(chunks.every((chunk) => chunk.pageStart === chunk.pageEnd)).toBe(true);
    });

    it('also when the number is the last line of the paragraph block itself, with no blank line before it', () => {
      const pages = [
        page(1, [`${paragraph(1, 3)} and then the survey party left\n12`]),
        page(2, ['A new beginning on the next page.']),
      ];
      expect(chunkDocument(pages, OPTS).every((chunk) => chunk.pageStart === chunk.pageEnd)).toBe(true);
    });

    it('still joins a paragraph that runs over the page break when nothing like a footer ends the page', () => {
      for (const tail of [
        'the survey was finished in 1884',
        'and the keeper went to page 12',
        'a mile and a half from the town of 3',
      ]) {
        const pages = [page(1, [paragraph(1, 2), tail]), page(2, ['and the lamp was lit at dusk.'])];
        const crossing = chunkDocument(pages, OPTS).filter((chunk) => chunk.pageStart !== chunk.pageEnd);
        expect(crossing, tail).toHaveLength(1);
      }
    });

    it('keeps a long line that merely ends in a number as running text', () => {
      const long =
        'The ledger records that the harbour master counted the boats that came in during the autumn of 1884';
      const pages = [page(1, [long]), page(2, ['and the next ones followed in spring.'])];
      expect(chunkDocument(pages, OPTS).filter((chunk) => chunk.pageStart !== chunk.pageEnd)).toHaveLength(1);
    });
  });

  it('keeps the pages of a scan apart: pages made by the OCR page builder, each ending on its page number, give chunks of one page each', () => {
    // Gemini's answer for a page: one line per printed line, a blank line between paragraphs, the page number last.
    const scanned = (pageNumber: number, paragraphs: string[]): ChunkPageInput => {
      const built = buildOcrPageText(
        {
          text: [...paragraphs, String(pageNumber)].join('\n\n'),
          confidence: null,
          lines: [],
          languagesUsed: [],
          layout: 'page',
        },
        { pageWidth: 600, pageHeight: 800, imageWidth: 600, imageHeight: 800 },
      );
      return { pageNumber, text: built.text, language: 'en', blocks: built.blocks };
    };
    const pages = [
      scanned(1, [
        paragraph(1, 3),
        'and the surveyors went on along the shore until the light began to fail',
      ]),
      scanned(2, [paragraph(10, 3), 'and the keeper wrote it all down in the blue ledger before he slept']),
      scanned(3, [paragraph(20, 2)]),
    ];
    const chunks = chunkDocument(pages, { ...OPTIONS, overlapChars: 0, targetChars: 1000, maxChars: 1500 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.every((chunk) => chunk.pageStart === chunk.pageEnd)).toBe(true);
    // A citation of one chunk highlights the lines of its own page only.
    expect(
      chunks.every((chunk) => chunk.highlights.every((highlight) => highlight.page === chunk.pageStart)),
    ).toBe(true);
    // The same pages without the numbers are what the paragraph rule was made for: the first runs on into the second.
    const unnumbered = [1, 2].map(
      (n) =>
        ({
          ...pages[n - 1],
          text: pages[n - 1]?.text.replace(/\n\n\d$/u, '') ?? '',
          blocks: (pages[n - 1]?.blocks ?? []).slice(0, -1),
        }) as ChunkPageInput,
    );
    expect(
      chunkDocument(unnumbered, { ...OPTIONS, overlapChars: 0, targetChars: 1000, maxChars: 1500 }).some(
        (chunk) => chunk.pageStart !== chunk.pageEnd,
      ),
    ).toBe(true);
  });

  it('joins a heading at the foot of a page with the text that follows it on the next page', () => {
    const pages = [
      page(1, [paragraph(1, 2), { text: 'Orphan Heading', heading: true }]),
      page(2, ['The first words under it.']),
    ];
    const chunks = chunkDocument(pages, { ...OPTIONS, overlapChars: 0 });
    const joined = chunks.find((chunk) => chunk.content.startsWith('Orphan Heading'));
    expect(joined?.pageStart).toBe(1);
    expect(joined?.pageEnd).toBe(2);
    expect(joined?.sectionTitle).toBe('Orphan Heading');
  });

  it('merges a chunk smaller than the minimum into the previous chunk of the same page and section', () => {
    const big = paragraph(1, 5);
    const pages = [page(1, [big, 'A short closing remark.'])];
    const merged = chunkDocument(pages, { ...OPTIONS, overlapChars: 0, targetChars: big.length });
    expect(merged).toHaveLength(1);
    expect(merged[0]?.content.endsWith('A short closing remark.')).toBe(true);
    // A heading's chunk is its own section: it stays small.
    const kept = chunkDocument([page(1, [big, { text: 'Tiny', heading: true }, 'Short.'])], {
      ...OPTIONS,
      overlapChars: 0,
      targetChars: big.length,
    });
    expect(kept).toHaveLength(2);
    expect(kept[1]?.content).toBe('Tiny\n\nShort.');
  });

  it('splits Arabic text at sentence ends ("؟" and ".") without reversing or rearranging it', () => {
    const sentences = [
      'أسس المكتبة الرحالة يوسف القرطبي وهو عالم جمع كتبه من الأسواق والموانئ البعيدة.',
      'هل يمكن أن تكون الأوراق المفقودة مخبأة خلف الجدار؟',
      'يرى الباحثون أن الإجابة قد تظهر يوما ما في أحد الصناديق القديمة.',
      'وأصبحت المكتبة مفتوحة للجميع كل يوم بعد ترميم طويل استمر سنوات.',
      'تقع المكتبة في قلب المدينة القديمة وقد بنيت قبل أكثر من ثلاثة قرون.',
    ];
    const text = sentences.join(' ');
    const chunks = chunkDocument([page(1, [text], 'ar')], {
      targetChars: 140,
      maxChars: 190,
      minChars: 20,
      overlapChars: 0,
    });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(text).toContain(chunk.content); // a contiguous slice, in the original order
      expect(chunk.direction).toBe('rtl');
      expect(chunk.language).toBe('ar');
      expect(/[.؟]$/u.test(chunk.content)).toBe(true);
      expect(chunk.content.length).toBeLessThanOrEqual(190);
    }
    expect(chunks.map((chunk) => chunk.content).join(' ')).toBe(text);
    expect(chunks.some((chunk) => chunk.content.endsWith('؟'))).toBe(true);
  });

  it('splits an over-long sentence at clauses and words, and never loses a character', () => {
    const long =
      Array.from({ length: 60 }, (_, i) => `word${String(i)}`).join(' ') +
      ', and then ' +
      Array.from({ length: 60 }, (_, i) => `term${String(i)}`).join(' ');
    const chunks = chunkDocument([page(1, [long])], { ...OPTIONS, overlapChars: 0 });
    for (const chunk of chunks) expect(chunk.content.length).toBeLessThanOrEqual(OPTIONS.maxChars);
    expect(chunks.map((chunk) => chunk.content).join(' ')).toBe(long);
    const hard = 'x'.repeat(2000);
    const pieces = chunkDocument([page(1, [hard])], { ...OPTIONS, overlapChars: 0 });
    expect(pieces.every((chunk) => chunk.content.length <= OPTIONS.maxChars)).toBe(true);
    expect(pieces.map((chunk) => chunk.content).join('')).toBe(hard);
  });

  it('keeps chunks within the token limit', () => {
    const chunks = chunkDocument([page(1, [paragraph(1, 40)])], {
      ...OPTIONS,
      overlapChars: 60,
      maxChars: 5000,
      targetChars: 5000,
      maxTokens: 60,
    });
    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(60);
      expect(chunk.tokenCount).toBe(estimateTokens(chunk.content));
    }
  });

  it('splits a heading that is longer than the maximum like any other block (no chunk exceeds it)', () => {
    // A run-in heading: the "title" is the whole first paragraph (an outline title matched the start of a long block).
    const runIn = paragraph(1, 14); // about 1,200 characters
    const chunks = chunkDocument([page(1, [{ text: runIn, heading: true }, paragraph(15, 3)])], {
      ...OPTIONS,
      overlapChars: 0,
    });
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) expect(chunk.content.length).toBeLessThanOrEqual(OPTIONS.maxChars);
    // The section title is capped, and begins with the heading's own words.
    expect(chunks[0]?.sectionTitle?.length).toBeLessThanOrEqual(160);
    expect(chunks[0]?.sectionTitle?.startsWith('This is sentence number 1 ')).toBe(true);
    expect(chunks.map((chunk) => own(chunk)).join(' ')).toContain(runIn.slice(0, 200));
  });

  it('keeps a short heading in the chunk of its section: only an over-long one is split', () => {
    const chunks = chunkDocument(
      [page(1, [{ text: 'The Founding', heading: true }, paragraph(1, 3)])],
      OPTIONS,
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.sectionTitle).toBe('The Founding');
    expect(chunks[0]?.content.startsWith('The Founding')).toBe(true);
  });

  it('puts highlight rectangles inside the page, one entry per page the chunk touches', () => {
    const pages = [page(1, ['Heading line', paragraph(1, 8)]), page(2, [paragraph(9, 8)])];
    for (const chunk of chunkDocument(pages, OPTIONS)) {
      expect(chunk.highlights.length).toBeGreaterThan(0);
      for (const highlight of chunk.highlights) {
        expect(highlight.rects.length).toBeGreaterThan(0);
        for (const rect of highlight.rects) {
          for (const value of [rect.x, rect.y, rect.w, rect.h]) {
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(1);
          }
          expect(rect.x + rect.w).toBeLessThanOrEqual(1);
          expect(rect.y + rect.h).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('gives a page whose lines all have the whole page as their rectangle (no boxes: OCR by Gemini) one rectangle', () => {
    const whole = { x: 0, y: 0, w: 1, h: 1 };
    const spec = page(1, [paragraph(1, 3), paragraph(4, 3)]);
    for (const block of spec.blocks) for (const line of block.lines) line.rect = { ...whole };
    const [chunk] = chunkDocument([spec], OPTIONS);
    expect(chunk?.highlights).toHaveLength(1);
    expect(chunk?.highlights[0]?.rects).toEqual([whole]);
  });

  it('gives a chunk the majority language of its blocks (by letters) and ignores undetermined blocks', () => {
    const spec = page(1, [paragraph(1, 3), 'Une courte phrase en français ici.', '12 34']);
    const [english, french] = spec.blocks.map((block, index) => ({
      ...block,
      language: index === 1 ? 'fr' : index === 2 ? 'und' : 'en',
    }));
    const mixed: ChunkPageInput = {
      ...spec,
      blocks: [
        english as ChunkBlockInput,
        french as ChunkBlockInput,
        { ...spec.blocks[2]!, language: 'und' },
      ],
    };
    expect(chunkDocument([mixed], { ...OPTIONS, targetChars: 2000, maxChars: 3000 })[0]?.language).toBe('en');
    expect(
      chunkDocument([{ ...mixed, blocks: [mixed.blocks[1]!, mixed.blocks[2]!] }], OPTIONS)[0]?.language,
    ).toBe('fr');
  });

  it('has a normalised search text without the overlap', () => {
    const chunks = chunkDocument([page(1, ['Box MS-4471 holds the letters of 14 March 1847.'])], OPTIONS);
    expect(chunks[0]?.searchText).toContain('ms 4471');
    expect(chunks[0]?.searchText).toContain('14 march 1847');
  });

  it('returns nothing for pages without text', () => {
    expect(chunkDocument([page(1, []), page(2, [''])], OPTIONS)).toEqual([]);
    expect(chunkDocument([], OPTIONS)).toEqual([]);
  });
});

describe('enforceTokenWindow', () => {
  // A counter far stricter than the estimate: one token per two characters, as for a page of digits or emoji.
  const strict = (text: string): number => Math.ceil(text.length / 2);
  const WINDOW = { maxTokens: 150, countTokens: strict };

  it('splits every chunk the exact counter finds too long, losing no text and keeping offsets exact', () => {
    const pages = [page(1, ['Heading', paragraph(1, 12), paragraph(13, 12)]), page(2, [paragraph(25, 14)])];
    const options = { ...OPTIONS, overlapChars: 0 };
    const chunks = chunkDocument(pages, options);
    expect(chunks.some((chunk) => strict(chunk.content) > WINDOW.maxTokens)).toBe(true);
    const fitted = enforceTokenWindow(chunks, pages, options, WINDOW);
    expect(fitted.length).toBeGreaterThan(chunks.length);
    expect(fitted.map((chunk) => chunk.index)).toEqual(fitted.map((_, index) => index));
    for (const chunk of fitted) {
      expect(strict(chunk.content), `chunk ${String(chunk.index)}`).toBeLessThanOrEqual(WINDOW.maxTokens);
      expect(chunk.tokenCount).toBeLessThanOrEqual(WINDOW.maxTokens);
      const source = pages[chunk.pageStart - 1]?.text ?? '';
      expect(source.slice(chunk.charStart, chunk.charEnd)).toBe(own(chunk));
    }
    // Every word of the document is still in some chunk, once.
    const words = (text: string): string[] => text.split(/\s+/u).filter(Boolean);
    const original = pages.flatMap((p) => words(p.text));
    const kept = fitted.flatMap((chunk) => words(own(chunk)));
    expect(kept).toEqual(original);
  });

  it('returns chunks that fit untouched, and carries the section into the pieces of one that does not', () => {
    const pages = [page(1, [{ text: 'The Founding', heading: true }, paragraph(1, 3), paragraph(4, 3)])];
    const options = { ...OPTIONS, targetChars: 2000, maxChars: 2000, overlapChars: 0 };
    const chunks = chunkDocument(pages, options);
    expect(chunks).toHaveLength(1);
    const untouched = enforceTokenWindow(chunks, pages, options, { maxTokens: 10_000, countTokens: strict });
    expect(untouched).toEqual(chunks);
    const split = enforceTokenWindow(chunks, pages, options, WINDOW);
    expect(split.length).toBeGreaterThanOrEqual(2);
    expect(split.every((chunk) => chunk.sectionTitle === 'The Founding')).toBe(true);
    expect(split.every((chunk) => strict(chunk.content) <= WINDOW.maxTokens)).toBe(true);
  });
});

describe('estimateTokens', () => {
  const samples: Record<string, string> = {
    arabicNumbers: 'سجل رقم ١٢٣٤٥٦٧٨٩٠ في الصندوق MS-4471 بتاريخ ١٩٩٩/١٢/٣١ ثم ٢٠٠٠ و٣٥٠٠ و٧٨٩٠١٢',
    references:
      'Smith, J. (2020). Archives. https://doi.org/10.1000/xyz123?utm=a&b=c#frag; https://example.org/a/b/c_d-e',
    formulas:
      'E = mc^2; \u2211_{i=1}^{n} x_i \u2264 \u221A(a^2 + b^2) \u2192 \u221E, \u03B1\u03B2\u03B3 \u2260 \u03B4',
    boxTable:
      '\u250C\u2500\u2500\u2500\u2500\u252C\u2500\u2500\u2500\u2500\u2510 \u2502 a \u2502 b \u2502 \u251C\u2500\u2500\u2500\u2500\u253C\u2500\u2500\u2500\u2500\u2524',
    emoji: '\u{1F600}\u{1F4DA}\u{1F5C4}\uFE0F\u{1F989} \u{1F600}\u{1F4DA}\u{1F5C4}\uFE0F\u{1F989}',
  };

  it('never falls below one token for every two characters of the hardest kinds of text', () => {
    for (const [name, text] of Object.entries(samples)) {
      const characters = Array.from(text).filter((char) => !/\s/u.test(char)).length;
      expect(estimateTokens(text), name).toBeGreaterThanOrEqual(Math.floor(characters * 0.5));
    }
  });

  it('keeps the cost of plain prose near a quarter of its length, so prose chunks stay large', () => {
    const prose = paragraph(1, 10);
    expect(estimateTokens(prose)).toBeLessThan(prose.length * 0.45);
    expect(estimateTokens(prose)).toBeGreaterThan(prose.length * 0.2);
  });
});
