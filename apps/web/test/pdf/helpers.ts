import { vi } from 'vitest';
import type { PdfDocumentLike, PdfPageLike } from '../../src/pdf/pageRenderer';
import { recordingCanvas, type RecordedCall } from '../helpers/recordingCanvas';

export interface FakePage {
  page: PdfPageLike;
  render: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  cleanup: ReturnType<typeof vi.fn>;
  /** Finishes the render under way. */
  finish(): void;
  /** Fails the render under way. */
  fail(error: Error): void;
}

/** A PDF page of `width` x `height` points whose render stays pending until `finish()` (or is already done). */
export function fakePage(width: number, height: number, options: { auto?: boolean } = {}): FakePage {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const cancel = vi.fn(() => {
    reject(Object.assign(new Error('Rendering cancelled'), { name: 'RenderingCancelledException' }));
  });
  const cleanup = vi.fn();
  const render = vi.fn(() => ({
    promise: new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
      if (options.auto) res();
    }),
    cancel,
  }));
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: width * scale, height: height * scale }),
    render,
    cleanup,
  } as unknown as PdfPageLike;
  return {
    page,
    render,
    cancel,
    cleanup,
    finish: () => {
      resolve();
    },
    fail: (error) => {
      reject(error);
    },
  };
}

export function fakeDocument(
  pages: Record<number, PdfPageLike>,
  numPages = Object.keys(pages).length,
): PdfDocumentLike {
  return {
    numPages,
    getPage: (n: number) => {
      const page = pages[n];
      return page ? Promise.resolve(page) : Promise.reject(new Error(`no page ${String(n)}`));
    },
  } as unknown as PdfDocumentLike;
}

/** Canvas factory plus the calls recorded on every context it hands out (all contexts share one log). */
export function canvasKit() {
  const recorder = recordingCanvas();
  return { ...recorder, names: (): string[] => recorder.calls.map((call: RecordedCall) => call.name) };
}

/** Lets promise callbacks and zero-delay timers run. */
export async function settle(turns = 3): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * A canvas factory whose contexts log, in order, every draw call and every change of `globalCompositeOperation`
 * (`op:multiply`), so a test can check WHEN the page is multiplied onto the parchment.
 */
export function orderedCanvasKit() {
  const events: string[] = [];
  const canvases: HTMLCanvasElement[] = [];
  const create = (width: number, height: number): HTMLCanvasElement => {
    const state: Record<string, unknown> = { globalCompositeOperation: 'source-over' };
    const ctx = new Proxy(
      {},
      {
        get: (_target, key: string) => {
          if (key in state) return state[key];
          if (key === 'createLinearGradient' || key === 'createRadialGradient')
            return () => ({ addColorStop: () => undefined });
          if (key === 'createPattern') return () => ({});
          if (key === 'createImageData')
            return (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) });
          return () => {
            events.push(key === 'drawImage' ? `drawImage:${String(state.globalCompositeOperation)}` : key);
          };
        },
        set: (_target, key: string, value: unknown) => {
          state[key] = value;
          if (key === 'globalCompositeOperation') events.push(`op:${String(value)}`);
          return true;
        },
      },
    );
    const canvas = { width, height, getContext: () => ctx } as unknown as HTMLCanvasElement;
    canvases.push(canvas);
    return canvas;
  };
  return { create, events, canvases };
}
