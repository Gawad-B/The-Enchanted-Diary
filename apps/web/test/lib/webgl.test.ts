import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectWebGL } from '../../src/lib/webgl';

function stubGetContext(implementation: (kind: string) => unknown) {
  return vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(((kind: string) => implementation(kind)) as HTMLCanvasElement['getContext']);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('detectWebGL', () => {
  it('reports support from a WebGL2 context and loses it straight away', () => {
    const loseContext = vi.fn();
    const getExtension = vi.fn((name: string) => (name === 'WEBGL_lose_context' ? { loseContext } : null));
    const spy = stubGetContext((kind) => (kind === 'webgl2' ? { getExtension } : null));
    expect(detectWebGL()).toEqual({ supported: true });
    expect(spy).toHaveBeenCalledWith('webgl2');
    expect(spy).not.toHaveBeenCalledWith('webgl');
    expect(getExtension).toHaveBeenCalledWith('WEBGL_lose_context');
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  it('falls back to WebGL1 when WebGL2 is not available', () => {
    const loseContext = vi.fn();
    const spy = stubGetContext((kind) =>
      kind === 'webgl' ? { getExtension: () => ({ loseContext }) } : null,
    );
    expect(detectWebGL().supported).toBe(true);
    expect(spy.mock.calls.map(([kind]) => kind)).toEqual(['webgl2', 'webgl']);
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  it('still reports support when the context cannot be released explicitly', () => {
    stubGetContext(() => ({ getExtension: () => null }));
    expect(detectWebGL()).toEqual({ supported: true });
  });

  it('reports no support, with a reason, when no context can be created', () => {
    stubGetContext(() => null);
    const result = detectWebGL();
    expect(result.supported).toBe(false);
    expect(result.reason).toMatch(/WebGL/);
  });

  it('reports no support, with the message, when context creation throws', () => {
    stubGetContext(() => {
      throw new Error('GPU process crashed');
    });
    expect(detectWebGL()).toEqual({ supported: false, reason: 'GPU process crashed' });
  });
});
