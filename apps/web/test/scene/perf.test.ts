import { describe, expect, it } from 'vitest';
import { FrameMeter, isSoftwareRenderer, readRendererStats } from '../../src/scene/perf';

const renderer = {
  info: { render: { calls: 72, triangles: 14249 }, memory: { geometries: 17, textures: 35 } },
} as unknown as Parameters<typeof readRendererStats>[0];

describe('readRendererStats', () => {
  it('reads the draw calls, triangles, geometries and textures', () => {
    expect(readRendererStats(renderer)).toEqual({
      calls: 72,
      triangles: 14249,
      geometries: 17,
      textures: 35,
    });
  });

  it('writes into the object it is given and returns it (it runs every frame: nothing is allocated)', () => {
    const out = { calls: 0, triangles: 0, geometries: 0, textures: 0 };
    expect(readRendererStats(renderer, out)).toBe(out);
    expect(out).toEqual({ calls: 72, triangles: 14249, geometries: 17, textures: 35 });
  });
});

describe('the frame meter and the renderer label', () => {
  it('averages the window and reports its worst frame', () => {
    const meter = new FrameMeter(4);
    for (const delta of [0.016, 0.016, 0.05, 0.016]) meter.push(delta);
    expect(meter.worstMs).toBeCloseTo(50, 5);
    expect(meter.fps).toBeCloseTo(4 / 0.098, 3);
  });

  it('knows a software rasterizer by name', () => {
    expect(isSoftwareRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device), SwiftShader driver)')).toBe(
      true,
    );
    expect(isSoftwareRenderer('ANGLE (Intel, Mesa Intel(R) Iris(R) Xe Graphics)')).toBe(false);
  });
});
