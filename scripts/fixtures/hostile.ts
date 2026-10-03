import { deflateSync } from 'node:zlib';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';

/*
 * Hostile PDFs. pdf.js decodes the pixels of an image into typed arrays, which live outside the heap limit of a worker
 * thread, so a small file can make the process grow by gigabytes. Two shapes:
 *  - many images, each just under the extraction limit (16 megapixels): every one is decoded, together they are a
 *    memory bomb (about 2 GB once decoded) that only the host's memory watchdog stops;
 *  - one image above the extraction limit: refused at once, which makes the page an unreadable scan.
 * The pixels are flat grey, stored with a PNG predictor (which makes pdf.js decode the whole image while it builds the
 * page's operator list) and deflated: a 14-megapixel image is 14 KB in the file.
 */

/** Just under the extraction limit of 16 million pixels (3800 x 3800 = 14.4 million), so each one is decoded. */
export const MANY_IMAGES_SIDE = 3800;
export const MANY_IMAGES_COUNT = 40;
/** Above the extraction limit, below pdf.js's own ceiling of 64 million. */
export const OVERSIZED_SIDE = 7900;

/** The compressed pixels of a flat grey image: one predictor byte (0 = none) and `side` samples per row. */
function flatGrey(side: number): Buffer {
  return deflateSync(Buffer.alloc((side + 1) * side, 0), { level: 9 });
}

/** A one-page PDF whose page draws `count` separate image XObjects (distinct objects, so each is decoded) of `side` pixels. */
async function pageWithImages(count: number, side: number): Promise<Uint8Array> {
  const pixels = flatGrey(side);
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const xObjects = doc.context.obj({});
  page.node.normalizedEntries().Resources.set(PDFName.of('XObject'), xObjects);
  const draws: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const image = PDFRawStream.of(
      doc.context.obj({
        Type: 'XObject',
        Subtype: 'Image',
        Width: side,
        Height: side,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 8,
        Filter: 'FlateDecode',
        DecodeParms: { Predictor: 15, Colors: 1, BitsPerComponent: 8, Columns: side },
      }),
      pixels,
    );
    xObjects.set(PDFName.of(`Im${String(i)}`), doc.context.register(image));
    draws.push(
      `q 60 0 0 60 ${String(20 + (i % 8) * 70)} ${String(40 + Math.floor(i / 8) * 70)} cm /Im${String(i)} Do Q`,
    );
  }
  page.node.addContentStream(doc.context.register(doc.context.flateStream(draws.join('\n'))));
  return doc.save();
}

/** `hostile-images.pdf`: 40 images of 14.4 megapixels on one page (about 2 GB once decoded). */
export async function hostileImagesPdf(): Promise<{ bytes: Uint8Array; note: string }> {
  return {
    bytes: await pageWithImages(MANY_IMAGES_COUNT, MANY_IMAGES_SIDE),
    note: `one page with ${String(MANY_IMAGES_COUNT)} grey images of ${String(MANY_IMAGES_SIDE)}x${String(MANY_IMAGES_SIDE)} (about 2 GB decoded: memory watchdog test)`,
  };
}

/** `oversized-image.pdf`: one 62-megapixel image: refused by the extraction limit, so the page is an unreadable scan. */
export async function oversizedImagePdf(): Promise<{ bytes: Uint8Array; note: string }> {
  return {
    bytes: await pageWithImages(1, OVERSIZED_SIDE),
    note: `one ${String(OVERSIZED_SIDE)}x${String(OVERSIZED_SIDE)} grey image page (above the extraction image limit)`,
  };
}
