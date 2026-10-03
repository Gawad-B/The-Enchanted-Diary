import type { Measure } from './layout';
import { fontsToLoad, type FaceSet } from './typography';

/*
 * Measuring text for the diary's pages: the 2D canvas measures a string in a font exactly as the browser will draw it (shaping
 * and joining included, which is what Arabic needs). Without a canvas (a test environment) a plain rule stands in, so the layout
 * still has widths to work with.
 */

type MeasuringContext = Pick<CanvasRenderingContext2D, 'font' | 'direction' | 'measureText'>;

let context: MeasuringContext | null | undefined;

function measuringContext(): MeasuringContext | null {
  if (context !== undefined) return context;
  context = null;
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    context = canvas.getContext('2d');
  }
  return context;
}

const SIZE = /(\d+(?:\.\d+)?)px/u;

/** A stand-in for a measure: a letter is about half the size of the font wide. Only used where there is no canvas. */
export const approximateMeasure: Measure = (text, font) => {
  const size = Number.parseFloat(SIZE.exec(font)?.[1] ?? '16');
  return Array.from(text).length * size * 0.48;
};

/** The canvas's measure of a text in a font, or the stand-in without one. */
export const canvasMeasure: Measure = (text, font, direction) => {
  const ctx = measuringContext();
  if (!ctx) return approximateMeasure(text, font, direction);
  ctx.font = font;
  ctx.direction = direction;
  return ctx.measureText(text).width;
};

/** Whether text can be measured for real (a canvas exists): when it cannot, the layout is an approximation. */
export const canMeasure = (): boolean => measuringContext() !== null;

function loadFont(font: string, text: string): Promise<unknown> {
  return typeof document !== 'undefined' && 'fonts' in document
    ? document.fonts.load(font, text)
    : Promise.resolve([]);
}

const requested = new Set<FaceSet>();

/** Starts loading the faces of a script's hands (once); resolves when they are there (or could not be got: the fallback face is used). */
export function loadDiaryFonts(faces: FaceSet): Promise<void> {
  requested.add(faces);
  return Promise.all(
    fontsToLoad(faces).map(({ font, text }) =>
      loadFont(font, text).catch(() => {
        /* a face that cannot load is replaced by the next one of its stack */
      }),
    ),
  ).then(() => undefined);
}

/** Calls back when the browser has finished loading more font files. Returns the way to stop. */
export function onFontsLoaded(callback: () => void): () => void {
  if (typeof document === 'undefined' || !('fonts' in document)) return () => undefined;
  document.fonts.addEventListener('loadingdone', callback);
  return () => {
    document.fonts.removeEventListener('loadingdone', callback);
  };
}
