import type { PDFFont, PDFPage } from 'pdf-lib';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';

/*
 * Fixtures built with pdf-lib: standard fonts, exact layout. All text is original.
 */

const PAGE = { width: 612, height: 792 } as const;
const MARGIN = 72;
const BODY = { size: 11, leading: 15, paragraphGap: 12 } as const;

interface Writer {
  doc: PDFDocument;
  page: PDFPage;
  y: number;
  body: PDFFont;
  bold: PDFFont;
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && line !== '') {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

async function newDocument(): Promise<{ doc: PDFDocument; body: PDFFont; bold: PDFFont }> {
  const doc = await PDFDocument.create();
  return {
    doc,
    body: await doc.embedFont(StandardFonts.TimesRoman),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
}

function startPage(writer: Writer): void {
  writer.page = writer.doc.addPage([PAGE.width, PAGE.height]);
  writer.y = PAGE.height - MARGIN;
}

function heading(writer: Writer, text: string, size: number): void {
  writer.y -= size;
  writer.page.drawText(text, { x: MARGIN, y: writer.y, size, font: writer.bold, color: rgb(0, 0, 0) });
  writer.y -= size * 1.1;
}

function paragraph(writer: Writer, text: string): void {
  for (const line of wrap(text, writer.body, BODY.size, PAGE.width - 2 * MARGIN)) {
    writer.y -= BODY.leading;
    writer.page.drawText(line, { x: MARGIN, y: writer.y, size: BODY.size, font: writer.body });
  }
  writer.y -= BODY.paragraphGap;
}

/** The 5-page English fixture: planted headings, a name, a date, a list, a table and an identifier. */
export async function textEnglish(): Promise<Uint8Array> {
  const { doc, body, bold } = await newDocument();
  const writer: Writer = { doc, body, bold, page: doc.addPage([PAGE.width, PAGE.height]), y: 0 };
  writer.y = PAGE.height - MARGIN;

  // Page 1: title and introduction.
  heading(writer, 'A Brief History of Thornquist House', 26);
  writer.y -= 8;
  paragraph(
    writer,
    'Thornquist House stands on a low hill above the river, and for almost two centuries it has served as a home, a school and a library. This short history gathers what is known about the building and the people who kept it.',
  );
  paragraph(
    writer,
    'The account is divided into five parts. It begins with the founding of the house, follows the story of its lost archive, and ends with a few words about what remains today.',
  );

  // Page 2: the founding.
  startPage(writer);
  heading(writer, 'The Founding', 18);
  writer.y -= 6;
  paragraph(
    writer,
    'The house was founded by Alaric Thornquist, a cartographer who bought the hill in the spring of 1847. According to the deed, the purchase was completed on 14 March 1847 and the first stones were laid before the summer.',
  );
  paragraph(
    writer,
    'Thornquist wanted a quiet place to draw his maps. He built a workroom with tall north windows, a cellar for the finished charts and a long table that is still in use.',
  );
  paragraph(
    writer,
    'His neighbours described him as careful, patient and fond of lists. He wrote the name of every visitor in a small green notebook.',
  );

  // Page 3: a numbered list and a small table, no heading.
  startPage(writer);
  paragraph(
    writer,
    'The keepers of the house followed a short set of rules, which are still posted in the hall.',
  );
  for (const item of [
    '1. Wash your hands before opening a book.',
    '2. Return every map to its own drawer.',
    '3. Write your name in the green notebook.',
  ]) {
    writer.y -= BODY.leading;
    writer.page.drawText(item, { x: MARGIN + 18, y: writer.y, size: BODY.size, font: writer.body });
  }
  writer.y -= 30;
  const columns = [MARGIN, MARGIN + 80, MARGIN + 240];
  const rows: [string, string, string][] = [
    ['Year', 'Keeper', 'Event'],
    ['1847', 'Alaric Thornquist', 'House founded'],
    ['1861', 'Mira Thornquist', 'School opened in the east wing'],
    ['1893', 'Edda Lindqvist', 'Library catalogue completed'],
    ['1952', 'Pavel Okonkwo', 'Roof repaired after the storm'],
  ];
  rows.forEach((row, rowIndex) => {
    writer.y -= BODY.leading + 3;
    row.forEach((cell, column) => {
      writer.page.drawText(cell, {
        x: columns[column] ?? MARGIN,
        y: writer.y,
        size: BODY.size,
        font: rowIndex === 0 ? writer.bold : writer.body,
      });
    });
  });

  // Page 4: the lost archive.
  startPage(writer);
  heading(writer, 'The Lost Archive', 18);
  writer.y -= 6;
  paragraph(
    writer,
    'In the autumn of 1893 the keeper Edda Lindqvist recorded that one box of papers had been moved from the cellar. The box was labelled with the identifier MS-4471 and contained letters, receipts and a half-finished map of the coast.',
  );
  paragraph(
    writer,
    'No later catalogue mentions MS-4471 again. Some believe the papers were sold to pay for the new roof; others say they were hidden behind a panel in the north wall, where the air stays dry.',
  );
  paragraph(writer, 'A search in 1952 found only an empty shelf and a faded label.');

  // Page 5: conclusion.
  startPage(writer);
  heading(writer, 'Conclusion', 18);
  writer.y -= 6;
  paragraph(
    writer,
    'Today Thornquist House is open to visitors on three afternoons a week. The workroom, the long table and the green notebooks can all be seen, though the lost archive has never been found.',
  );
  paragraph(
    writer,
    'The history of the house shows how a private project can become a public memory. It also shows how much depends on the people who take the trouble to write things down.',
  );

  return doc.save();
}

const ADJECTIVES = [
  'quiet',
  'ancient',
  'narrow',
  'bright',
  'hidden',
  'patient',
  'crooked',
  'gentle',
  'distant',
  'silver',
];
const NOUNS = [
  'harbour',
  'orchard',
  'lantern',
  'bridge',
  'meadow',
  'chapel',
  'workshop',
  'staircase',
  'garden',
  'tower',
];
const VERBS = [
  'faces',
  'borders',
  'overlooks',
  'follows',
  'shelters',
  'crosses',
  'guards',
  'surrounds',
  'joins',
  'divides',
];

/** `pages` pages of distinct, numbered paragraphs (for progress reporting and page virtualisation). */
export async function numberedPages(
  pages: number,
  title: string,
  paragraphsPerPage = 3,
): Promise<Uint8Array> {
  const { doc, body, bold } = await newDocument();
  const writer: Writer = { doc, body, bold, page: doc.addPage([PAGE.width, PAGE.height]), y: 0 };
  for (let p = 1; p <= pages; p += 1) {
    if (p > 1) startPage(writer);
    else writer.y = PAGE.height - MARGIN;
    writer.y -= 11;
    writer.page.drawText(`${title} - page ${String(p)} of ${String(pages)}`, {
      x: MARGIN,
      y: writer.y,
      size: 9,
      font: body,
    });
    writer.y -= 30;
    for (let k = 1; k <= paragraphsPerPage; k += 1) {
      const n = (p - 1) * paragraphsPerPage + k;
      const a = ADJECTIVES[n % ADJECTIVES.length] ?? '';
      const noun = NOUNS[(n * 3) % NOUNS.length] ?? '';
      const verb = VERBS[(n * 7) % VERBS.length] ?? '';
      const other = NOUNS[(n * 5 + 1) % NOUNS.length] ?? '';
      paragraph(
        writer,
        `Paragraph ${String(p)}.${String(k)} (number ${String(n)}). The ${a} ${noun} number ${String(n)} ${verb} the old ${other}, and a note written beside entry ${String(n)} says that visitors should return before the evening bell. This sentence belongs to paragraph ${String(n)} and to no other.`,
      );
    }
  }
  return doc.save();
}

/** One blank page. */
export async function blankPage(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([PAGE.width, PAGE.height]);
  return doc.save();
}

/**
 * One page with /Rotate 90 whose text is drawn so that it reads upright on the displayed (rotated) page. A
 * title and a paragraph sit in the top-left of what the reader sees.
 */
export async function rotatedPage(): Promise<Uint8Array> {
  const { doc, body, bold } = await newDocument();
  const page = doc.addPage([595, 842]);
  page.setRotation(degrees(90));
  // Displayed (X, Y from the top-left) = (user y, user x): text rotated 90 degrees counter-clockwise in user space
  // reads left to right once the page is shown rotated clockwise.
  const place = (text: string, displayX: number, displayY: number, size: number, font: PDFFont): void => {
    page.drawText(text, { x: displayY, y: displayX, size, font, rotate: degrees(90) });
  };
  place('The Rotated Page', 72, 90, 22, bold);
  place('This page is stored sideways but is displayed upright, so its text must be read', 72, 130, 11, body);
  place('in the order a person sees it, from the top left of the displayed page.', 72, 145, 11, body);
  return doc.save();
}
