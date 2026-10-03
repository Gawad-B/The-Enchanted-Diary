import { CanvasTexture, SRGBColorSpace, type Texture } from 'three';
import type { Direction } from '@enchanted/shared';
import type { Language } from '../i18n/strings';
import type { LeafFace } from './bookLayout';
import { bookplateModel, fitText, wrapWords, type BookplateInput } from './faceLayout';
import type { PageTextureSource } from './pageSource';
import {
  drawFlourishLine,
  drawInkText,
  drawMedallion,
  drawParchment,
  mulberry32,
  type Ctx2D,
} from './paperTexture';
import { STRINGS } from '../i18n/strings';
import { runBuild } from '../lib/buildScheduler';
import { drawMarblePlaceholder, marbleSteps } from './marbleTexture';
import { ENDPAPER_ASPECT, PAGE_ASPECT } from './pageAspect';

/*
 * The diary's own pages, before a document is loaded and as the frame around one: the flyleaf with its
 * invitation, the bookplate, the marbled endpaper and plain parchment. Drawn with the 2D canvas; the text is
 * ink on parchment in the diary's hands (Petit Formal Script for Latin, Aref Ruqaa for Arabic). Web fonts are
 * loaded with `document.fonts.load()` before anything is drawn, and the faces are drawn again when fonts
 * finish loading, so the first frame never shows a fallback face for good.
 */

export { ENDPAPER_ASPECT, PAGE_ASPECT };

type NonPageFace = 'flyleaf' | 'bookplate' | 'endpaper' | 'blank';

const INK = '#2a1410';
const INK_SOFT = 'rgba(58, 32, 20, 0.42)';
/** Fraction of the face width the text moves toward the fore-edge. */
const INNER_MARGIN_SHIFT = 0.05;

export interface ParchmentSourceDeps {
  /** Width of the text-bearing faces, in pixels (the tier's page texture width). */
  pageWidth: number;
  language?: Language;
  /** The direction the book is laid out in; the faces keep a wider margin on the side of the binding. */
  direction?: Direction;
  document?: BookplateInput | null;
  anisotropy?: number;
  createCanvas?: (width: number, height: number) => HTMLCanvasElement;
  /** Loads a web font (and the subset for `text`) before it is drawn with. */
  loadFont?: (font: string, text: string) => Promise<unknown>;
  /** Called with a callback to run when more fonts finished loading; returns the cleanup. */
  onFontsLoaded?: (callback: () => void) => () => void;
}

function defaultCreateCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function defaultLoadFont(font: string, text: string): Promise<unknown> {
  return typeof document !== 'undefined' && 'fonts' in document
    ? document.fonts.load(font, text)
    : Promise.resolve([]);
}

function defaultOnFontsLoaded(callback: () => void): () => void {
  if (typeof document === 'undefined' || !('fonts' in document)) return () => undefined;
  document.fonts.addEventListener('loadingdone', callback);
  return () => {
    document.fonts.removeEventListener('loadingdone', callback);
  };
}

export class ParchmentPageSource implements PageTextureSource {
  readonly id = 'parchment';
  private readonly textures = new Map<NonPageFace, CanvasTexture>();
  private placeholder: CanvasTexture | null = null;
  private readonly drawing = new Map<NonPageFace, Promise<void>>();
  private readonly dirty = new Set<NonPageFace>();
  private readonly reportedFonts = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly stopFontWatch: () => void;
  private language: Language;
  private direction: Direction;
  private info: BookplateInput | null;
  private disposed = false;
  private readonly createCanvas: (width: number, height: number) => HTMLCanvasElement;
  private readonly loadFont: (font: string, text: string) => Promise<unknown>;

  constructor(private readonly deps: ParchmentSourceDeps) {
    this.language = deps.language ?? 'en';
    this.direction = deps.direction ?? 'ltr';
    this.info = deps.document ?? null;
    this.createCanvas = deps.createCanvas ?? defaultCreateCanvas;
    this.loadFont = deps.loadFont ?? defaultLoadFont;
    // Fonts that arrive late repaint the faces that carry text.
    this.stopFontWatch = (deps.onFontsLoaded ?? defaultOnFontsLoaded)(() => {
      this.markDirty('flyleaf');
      this.markDirty('bookplate');
    });
  }

  private static isOwnFace(face: LeafFace): face is NonPageFace {
    return face === 'flyleaf' || face === 'bookplate' || face === 'endpaper' || face === 'blank';
  }

  /** A page number is not drawn here: its face is plain parchment, which is also the final texture. */
  private static resolve(face: LeafFace): NonPageFace {
    return ParchmentPageSource.isOwnFace(face) ? face : 'blank';
  }

  getTexture(face: LeafFace): Texture | null {
    const own = ParchmentPageSource.resolve(face);
    const texture = this.textures.get(own);
    if (!texture) this.schedule(own);
    // The endpaper takes a while to draw (the marbling is worked out a slice per turn); until it is there a flat sheet of
    // its mean colour stands in, so the book does not show pale parchment first and jump to a dark sheet.
    return texture ?? (own === 'endpaper' ? this.endpaperPlaceholder() : null);
  }

  isReady(face: LeafFace): boolean {
    const own = ParchmentPageSource.resolve(face);
    return this.textures.has(own) && !this.dirty.has(own) && !this.drawing.has(own);
  }

  request(faces: readonly LeafFace[]): void {
    for (const face of faces) this.schedule(ParchmentPageSource.resolve(face));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The interface language changed: the flyleaf's invitation and the bookplate are written again. */
  setLanguage(language: Language): void {
    if (language === this.language) return;
    this.language = language;
    this.markDirty('flyleaf');
    this.markDirty('bookplate');
  }

  /**
   * The layout direction changed: the text of the flyleaf and the bookplate sits a little toward the fore-edge,
   * away from the gutter where the page sinks, so no line is lost in the curve (a book's inner margin).
   */
  setDirection(direction: Direction): void {
    if (direction === this.direction) return;
    this.direction = direction;
    this.markDirty('flyleaf');
    this.markDirty('bookplate');
  }

  /** Horizontal shift of the text away from the binding, in pixels, for a face `width` wide. */
  private marginShift(width: number): number {
    // The front face's u grows from the spine for LTR (binding on the left) and towards it for RTL.
    return (this.direction === 'ltr' ? 1 : -1) * width * INNER_MARGIN_SHIFT;
  }

  /** The document the bookplate describes (null before one is loaded). */
  setDocument(info: BookplateInput | null): void {
    this.info = info;
    this.markDirty('bookplate');
  }

  dispose(): void {
    this.disposed = true;
    this.stopFontWatch();
    for (const texture of this.textures.values()) texture.dispose();
    this.textures.clear();
    this.placeholder?.dispose();
    this.placeholder = null;
    this.listeners.clear();
  }

  private markDirty(face: NonPageFace): void {
    if (!this.textures.has(face)) return; // nothing drawn yet: the first draw will use the current inputs
    this.dirty.add(face);
    this.schedule(face);
  }

  private schedule(face: NonPageFace): void {
    if (this.disposed || this.drawing.has(face)) return;
    const task = this.draw(face)
      .catch((error: unknown) => {
        console.error(`[ParchmentPageSource] could not draw the ${face} face`, error);
      })
      .finally(() => {
        this.drawing.delete(face);
        // Inputs changed while this draw ran: draw again.
        if (this.dirty.has(face) && !this.disposed) this.schedule(face);
      });
    this.drawing.set(face, task);
  }

  private faceSize(face: NonPageFace): { width: number; height: number } {
    const text = face === 'flyleaf' || face === 'bookplate';
    // The pastedown is seen at most about 600 px wide at dpr 1: it is drawn at 0.75 of the tier's page width, not scaled up.
    const width = Math.round(
      text ? this.deps.pageWidth : this.deps.pageWidth * (face === 'endpaper' ? 0.75 : 0.6),
    );
    return { width, height: Math.round(width * (face === 'endpaper' ? ENDPAPER_ASPECT : PAGE_ASPECT)) };
  }

  /** The fonts a face is drawn with, so they can be loaded first. */
  private fontsFor(face: NonPageFace): { font: string; text: string }[] {
    const copy = STRINGS[this.language];
    if (face === 'flyleaf') {
      return this.language === 'ar'
        ? [{ font: '64px "Aref Ruqaa"', text: copy.invitation.placeDocument }]
        : [{ font: '64px "Petit Formal Script"', text: copy.invitation.placeDocument }];
    }
    if (face === 'bookplate' && this.info) {
      const model = bookplateModel(this.info, copy.scene.bookplate, this.language);
      const sample = `${model.heading}${model.title}${model.pages}${model.languages ?? ''}${model.bound}`;
      return [
        { font: '40px "EB Garamond"', text: sample },
        { font: 'italic 40px "Cormorant Infant"', text: sample },
        { font: '40px "Amiri"', text: sample },
      ];
    }
    return [];
  }

  /** A font that cannot load is reported once; the face is drawn with the browser's fallback face instead. */
  private reportFontFailure(font: string, error: unknown): void {
    if (this.reportedFonts.has(font)) return;
    this.reportedFonts.add(font);
    console.warn(`[diary] the font "${font}" could not be loaded; the page uses a fallback face`, error);
  }

  private async draw(face: NonPageFace): Promise<void> {
    this.dirty.delete(face);
    await Promise.all(
      this.fontsFor(face).map(({ font, text }) =>
        this.loadFont(font, text).catch((error: unknown) => {
          this.reportFontFailure(font, error);
        }),
      ),
    );
    if (this.disposed) return;
    const { width, height } = this.faceSize(face);
    const existing = this.textures.get(face);
    const canvas = existing ? existing.image : this.createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // no 2D canvas (a test environment): the face stays unavailable
    if (face === 'endpaper') {
      // The marbling covers every pixel of the canvas when it is put down, so there is nothing to clear; and it is worked
      // out a few rows per turn of the event loop (a single 0.2 to 0.7 s task would freeze the page at every mount).
      await this.paintMarbled(ctx, canvas.width, canvas.height);
      if (this.isDisposed()) return; // went away while it was drawn, a slice at a time
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      this.paint(face, ctx, canvas.width, canvas.height);
    }
    if (existing) {
      existing.needsUpdate = true;
    } else {
      const texture = new CanvasTexture(canvas);
      texture.colorSpace = SRGBColorSpace;
      texture.anisotropy = this.deps.anisotropy ?? 4;
      this.textures.set(face, texture);
    }
    // A User Timing mark for the end to end test (and the curious): the face is on the page now.
    if (typeof performance !== 'undefined' && typeof performance.mark === 'function')
      performance.mark(`diary:face-ready:${face}`);
    for (const listener of [...this.listeners]) listener();
  }

  /** The stand-in for the endpaper while it is drawn: its mean colour in its leather turn-in, small (it is flat). */
  private endpaperPlaceholder(): CanvasTexture | null {
    if (this.placeholder || this.disposed) return this.placeholder;
    const width = 96;
    const canvas = this.createCanvas(width, Math.round(width * ENDPAPER_ASPECT));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    drawMarblePlaceholder(ctx, canvas.width, canvas.height, this.createCanvas, { turnIn: true });
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    this.placeholder = texture;
    return texture;
  }

  /** Whether the source was disposed (asked again after an await, where the earlier answer may be out of date). */
  private isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * The endpaper's marbling, a slice of rows per turn of the event loop, abandoned if the source goes away meanwhile.
   * Rejects with what a slice threw, so `schedule` reports it (with the face's name) and clears the face for a retry.
   */
  private paintMarbled(ctx: Ctx2D, width: number, height: number): Promise<void> {
    return new Promise((resolve, reject) => {
      runBuild(
        marbleSteps(ctx, width, height, this.createCanvas, 31, { turnIn: true }, () => this.isDisposed()),
        () => {
          resolve();
        },
        undefined,
        reject,
      );
    });
  }

  private paint(face: NonPageFace, ctx: Ctx2D, width: number, height: number): void {
    switch (face) {
      case 'blank':
        drawParchment(ctx, width, height, this.createCanvas, { seed: 101 });
        return;
      case 'endpaper':
        return; // drawn in slices by `paintMarbled`
      case 'flyleaf':
        this.paintFlyleaf(ctx, width, height);
        return;
      case 'bookplate':
        this.paintBookplate(ctx, width, height);
        return;
    }
  }

  /** Two thin rules inset from the edge, and a small flourish in each corner (alike under a half turn). */
  private paintFrame(ctx: Ctx2D, width: number, height: number): void {
    ctx.save();
    ctx.strokeStyle = INK_SOFT;
    const inset = width * 0.06;
    ctx.lineWidth = Math.max(1, width * 0.0014);
    ctx.strokeRect(inset, inset, width - 2 * inset, height - 2 * inset);
    ctx.lineWidth = Math.max(0.6, width * 0.0008);
    ctx.strokeRect(inset * 1.22, inset * 1.22, width - 2 * inset * 1.22, height - 2 * inset * 1.22);
    const corner = width * 0.075;
    for (const [x, y, rotation] of [
      [inset, inset, 0],
      [width - inset, height - inset, Math.PI],
      [width - inset, inset, Math.PI / 2],
      [inset, height - inset, -Math.PI / 2],
    ] as const) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rotation);
      ctx.lineWidth = Math.max(1, width * 0.0016);
      ctx.beginPath();
      ctx.moveTo(corner * 0.15, corner * 0.15);
      ctx.bezierCurveTo(corner * 0.9, corner * 0.1, corner * 0.9, corner * 0.8, corner * 0.35, corner * 0.7);
      ctx.bezierCurveTo(corner * 0.1, corner * 0.65, corner * 0.2, corner * 0.35, corner * 0.4, corner * 0.4);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  /**
   * The flyleaf (global section G zones): the top 40% holds the invitation drawn in the diary's hand, the
   * middle band the quill line where writing will appear, and the bottom band stays clear for the button.
   */
  private paintFlyleaf(ctx: Ctx2D, width: number, height: number): void {
    drawParchment(ctx, width, height, this.createCanvas, { seed: 11 });
    this.paintFrame(ctx, width, height);
    const shift = this.marginShift(width);
    const cx = width / 2 + shift;
    const copy = STRINGS[this.language];
    const arabic = this.language === 'ar';
    const family = arabic ? '"Aref Ruqaa"' : '"Petit Formal Script"';
    const maxWidth = width * 0.7;
    let size = width * (arabic ? 0.085 : 0.092);
    let lines: string[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      ctx.font = `${size}px ${family}`;
      ctx.direction = arabic ? 'rtl' : 'ltr';
      lines = wrapWords(copy.invitation.placeDocument, maxWidth, (text) => ctx.measureText(text).width);
      if (lines.length <= 2 && lines.every((line) => ctx.measureText(line).width <= maxWidth)) break;
      size *= 0.92;
    }
    const lineHeight = size * (arabic ? 1.55 : 1.4);
    const zoneCenter = height * 0.2;
    const firstBaseline = zoneCenter - ((lines.length - 1) * lineHeight) / 2 + size * 0.28;
    lines.forEach((line, index) => {
      drawInkText(ctx, line, cx, firstBaseline + index * lineHeight, {
        font: `${size}px ${family}`,
        color: INK,
        direction: arabic ? 'rtl' : 'ltr',
        bleed: Math.max(1.5, size * 0.03),
      });
    });
    // The quill line: a faint calligraphic stroke where the first words will be written.
    drawFlourishLine(
      ctx,
      width * 0.2 + shift,
      width * 0.8 + shift,
      height * 0.54,
      height * 0.012,
      Math.max(2, width * 0.0042),
      'rgba(58, 32, 20, 0.32)',
      5,
    );
    drawFlourishLine(
      ctx,
      width * 0.32 + shift,
      width * 0.68 + shift,
      height * 0.575,
      height * 0.008,
      Math.max(1.4, width * 0.0026),
      'rgba(58, 32, 20, 0.2)',
      9,
    );
  }

  private paintBookplate(ctx: Ctx2D, width: number, height: number): void {
    drawParchment(ctx, width, height, this.createCanvas, { seed: 23 });
    this.paintFrame(ctx, width, height);
    const shift = this.marginShift(width);
    const cx = width / 2 + shift;
    const copy = STRINGS[this.language];
    const arabic = this.language === 'ar';
    const small = arabic ? '"Amiri"' : '"EB Garamond"';
    ctx.save();
    drawMedallion(
      ctx,
      cx,
      height * 0.3,
      width * 0.13,
      'rgba(58, 32, 20, 0.5)',
      Math.max(1.2, width * 0.0018),
    );
    ctx.restore();
    if (!this.info) {
      drawInkText(ctx, copy.scene.bookplate.heading, cx, height * 0.6, {
        font: `${width * 0.05}px ${small}`,
        color: INK,
        direction: arabic ? 'rtl' : 'ltr',
        bleed: 1.5,
      });
      return;
    }
    const model = bookplateModel(this.info, copy.scene.bookplate, this.language);
    const direction = arabic ? 'rtl' : 'ltr';
    drawInkText(ctx, arabic ? model.heading : model.heading.toUpperCase(), cx, height * 0.185, {
      font: `${width * 0.034}px ${small}`,
      color: 'rgba(58, 32, 20, 0.85)',
      direction,
      bleed: 1,
    });
    // The manuscript's name: bidi-correct (the base direction follows the name), fitted to the plate.
    const titleStyle = model.titleDirection === 'rtl' || arabic ? '' : 'italic ';
    const titleFamily = model.titleDirection === 'rtl' || arabic ? '"Amiri"' : '"Cormorant Infant"';
    const titleSize = width * 0.068;
    const titleFont = `${titleStyle}${String(titleSize)}px ${titleFamily}`;
    ctx.font = titleFont;
    ctx.direction = model.titleDirection;
    const fitted = fitText(model.title, width * 0.6, (text) => ctx.measureText(text).width);
    drawInkText(ctx, fitted, cx, height * 0.5, {
      font: titleFont,
      color: INK,
      direction: model.titleDirection,
      bleed: Math.max(1.5, titleSize * 0.03),
    });
    drawFlourishLine(
      ctx,
      width * 0.26 + shift,
      width * 0.74 + shift,
      height * 0.545,
      height * 0.007,
      Math.max(1.6, width * 0.003),
      'rgba(58, 32, 20, 0.4)',
      14,
    );
    const lines = [model.pages, model.languages, model.bound].filter((line): line is string => Boolean(line));
    lines.forEach((line, index) => {
      ctx.font = `${width * 0.042}px ${small}`;
      ctx.direction = direction;
      const text = fitText(line, width * 0.7, (candidate) => ctx.measureText(candidate).width);
      drawInkText(ctx, text, cx, height * 0.62 + index * height * 0.05, {
        font: `${width * 0.042}px ${small}`,
        color: 'rgba(42, 20, 16, 0.9)',
        direction,
        bleed: 1,
      });
    });
    // A last seeded flourish keeps two bookplates from looking stamped from one die.
    const rng = mulberry32(model.title.length + 17);
    drawFlourishLine(
      ctx,
      width * (0.3 + rng() * 0.05) + shift,
      width * (0.7 - rng() * 0.05) + shift,
      height * 0.84,
      height * 0.01,
      Math.max(1.6, width * 0.003),
      'rgba(58, 32, 20, 0.3)',
      21,
    );
  }
}
