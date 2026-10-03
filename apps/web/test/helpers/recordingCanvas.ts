/** A canvas whose 2D context records every call (jsdom has no canvas), for tests of code that draws. */
export interface RecordedCall {
  name: string;
  args: unknown[];
}

export function recordingCanvas() {
  const calls: RecordedCall[] = [];
  const state: Record<string, unknown> = {
    direction: 'ltr',
    font: '',
    textAlign: 'start',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
  };
  const handler: ProxyHandler<object> = {
    get: (_target, key: string) => {
      if (key in state) return state[key];
      if (key === 'measureText') return (text: string) => ({ width: text.length * 10 });
      if (key === 'createLinearGradient' || key === 'createRadialGradient')
        return () => ({ addColorStop: () => undefined });
      if (key === 'createPattern') return () => ({});
      if (key === 'createImageData')
        return (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) });
      return (...args: unknown[]) => {
        calls.push({ name: key, args });
        if (key === 'fillText') calls.push({ name: `direction:${String(state.direction)}`, args: [] });
      };
    },
    set: (_target, key: string, value: unknown) => {
      state[key] = value;
      return true;
    },
  };
  const ctx = new Proxy({}, handler);
  const canvases: HTMLCanvasElement[] = [];
  const create = (width: number, height: number): HTMLCanvasElement => {
    const canvas = { width, height, getContext: () => ctx } as unknown as HTMLCanvasElement;
    canvases.push(canvas);
    return canvas;
  };
  return { create, calls, canvases };
}
