import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchContextLoss } from '../../src/scene/contextLoss';

let canvas: HTMLCanvasElement;
afterEach(() => {
  canvas.remove();
});

function lose(): void {
  canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
}

describe('watchContextLoss: a lost WebGL context sends the session to the simple view', () => {
  it('reports a context lost while the canvas is on the page', () => {
    canvas = document.createElement('canvas');
    document.body.append(canvas);
    const onLost = vi.fn();
    watchContextLoss(canvas, onLost);
    lose();
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it('does not report the context a canvas releases after it has been taken down on purpose (a tier change)', () => {
    canvas = document.createElement('canvas');
    document.body.append(canvas);
    const onLost = vi.fn();
    watchContextLoss(canvas, onLost);
    canvas.remove(); // React removed it; the renderer's forced context loss arrives a moment later
    lose();
    expect(onLost).not.toHaveBeenCalled();
  });

  it('stops watching when told to', () => {
    canvas = document.createElement('canvas');
    document.body.append(canvas);
    const onLost = vi.fn();
    const stop = watchContextLoss(canvas, onLost);
    stop();
    lose();
    expect(onLost).not.toHaveBeenCalled();
  });
});
