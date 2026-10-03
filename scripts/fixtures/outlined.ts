import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { PDFDocument } from 'pdf-lib';

/*
 * PDFs whose text was turned into vector outlines: no fonts, no text layer, no images, just filled paths. Print-ready
 * and flattened files are made this way (Illustrator and InDesign "create outlines", Ghostscript -dNoOutputFonts), often
 * for Arabic, to be safe from shaping problems. The only way to read them is OCR on a rendering of the page.
 */

const run = promisify(execFile);

/**
 * `pages` of `source` with every glyph drawn as a filled path (Ghostscript's `-dNoOutputFonts`). `scratchDir` holds the
 * input and output files while Ghostscript runs.
 */
export async function outlinePages(
  source: Uint8Array,
  pages: { first: number; last: number },
  scratchDir: string,
): Promise<Uint8Array> {
  await mkdir(scratchDir, { recursive: true });
  const input = path.join(scratchDir, 'outline-in.pdf');
  const output = path.join(scratchDir, 'outline-out.pdf');
  await writeFile(input, source);
  try {
    await run('gs', [
      '-q',
      '-dNOPAUSE',
      '-dBATCH',
      '-sDEVICE=pdfwrite',
      '-dNoOutputFonts',
      `-dFirstPage=${String(pages.first)}`,
      `-dLastPage=${String(pages.last)}`,
      `-sOutputFile=${output}`,
      input,
    ]);
    return new Uint8Array(await readFile(output));
  } finally {
    await rm(input, { force: true });
    await rm(output, { force: true });
  }
}

/** A PDF of the first page of `text` (a page with a text layer) and the first page of `outlined`. */
export async function textThenOutlined(text: Uint8Array, outlined: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const [first] = await doc.copyPages(await PDFDocument.load(text), [0]);
  const [second] = await doc.copyPages(await PDFDocument.load(outlined), [0]);
  if (first === undefined || second === undefined) throw new Error('a source PDF has no page');
  doc.addPage(first);
  doc.addPage(second);
  return doc.save();
}
