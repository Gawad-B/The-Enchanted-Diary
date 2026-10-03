import { pdfjs } from './load.js';

/**
 * Path data values of a small glyph outline. A path counts for one "vector path" per this many values (at least one),
 * so that a page whose glyphs were joined into a single big path counts for what it holds, not for one.
 */
const GLYPH_VALUES = 30;

/**
 * How many filled vector paths the page draws, from its operator list: the measure of text that was turned into outlines
 * (no font, no text layer, no image: only filled glyph shapes, hundreds of them), which a blank page and a page with a
 * rule or a border do not have. Strokes and clipping paths are not counted. pdf.js reports a path as one
 * `constructPath` operation with `[the painting operator, [the flat path data], the bounding box]`.
 */
export function vectorFillCount(fnArray: ArrayLike<number>, argsArray: ArrayLike<unknown>): number {
  const { OPS } = pdfjs;
  const fills: ReadonlySet<number> = new Set([
    OPS.fill,
    OPS.eoFill,
    OPS.fillStroke,
    OPS.eoFillStroke,
    OPS.closeFillStroke,
    OPS.closeEOFillStroke,
  ]);
  let count = 0;
  for (let i = 0; i < fnArray.length; i += 1) {
    if (fnArray[i] !== OPS.constructPath) continue;
    const args = argsArray[i];
    if (!Array.isArray(args)) continue;
    const [paint, data] = args as [unknown, unknown];
    if (typeof paint !== 'number' || !fills.has(paint)) continue;
    let values = 0;
    if (Array.isArray(data)) {
      for (const part of data as unknown[]) {
        values += (part as { length?: number } | null | undefined)?.length ?? 0;
      }
    }
    count += Math.max(1, Math.floor(values / GLYPH_VALUES));
  }
  return count;
}
