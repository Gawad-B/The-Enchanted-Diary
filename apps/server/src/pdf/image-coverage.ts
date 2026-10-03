import { pdfjs } from './load.js';

/**
 * How much of the page the images on it cover (0..1): the sum of the areas of the painted images, taken from
 * the operator list and the current transformation matrix, divided by the page area, capped at 1. Overlapping
 * images are counted twice, which only matters for the "mostly an image" test this feeds.
 */
export function imageCoverage(
  fnArray: ArrayLike<number>,
  argsArray: ArrayLike<unknown>,
  pageWidth: number,
  pageHeight: number,
): number {
  const { OPS } = pdfjs;
  const pageArea = pageWidth * pageHeight;
  if (!(pageArea > 0)) return 0;

  type Matrix = [number, number, number, number, number, number];
  const multiply = (m: Matrix, n: Matrix): Matrix => [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
  const isMatrix = (value: unknown): value is Matrix =>
    Array.isArray(value) && value.length === 6 && value.every((n) => typeof n === 'number');

  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  let covered = 0;
  const unitArea = (): number => Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]);

  for (let i = 0; i < fnArray.length; i += 1) {
    const op = fnArray[i];
    const args = argsArray[i];
    switch (op) {
      case OPS.save:
        stack.push(ctm);
        break;
      case OPS.restore:
        ctm = stack.pop() ?? ctm;
        break;
      case OPS.transform:
        if (isMatrix(args)) ctm = multiply(ctm, args);
        break;
      case OPS.paintFormXObjectBegin:
        stack.push(ctm);
        if (Array.isArray(args) && isMatrix(args[0])) ctm = multiply(ctm, args[0]);
        break;
      case OPS.paintFormXObjectEnd:
        ctm = stack.pop() ?? ctm;
        break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject:
        covered += unitArea();
        break;
      case OPS.paintImageXObjectRepeat:
      case OPS.paintImageMaskXObjectRepeat: {
        // [objId, scaleX, scaleY, positions]: positions holds x, y pairs.
        if (Array.isArray(args)) {
          const scaleX = typeof args[1] === 'number' ? args[1] : 1;
          const scaleY = typeof args[2] === 'number' ? args[2] : 1;
          const positions = Array.isArray(args[3]) ? args[3].length / 2 : 1;
          covered += unitArea() * Math.abs(scaleX * scaleY) * positions;
        }
        break;
      }
      default:
        break;
    }
  }
  return Math.min(1, covered / pageArea);
}
