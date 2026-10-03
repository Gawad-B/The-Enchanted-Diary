import type { WebGLRenderer } from 'three';

/*
 * Performance instrumentation (global section M / brief item 8): User Timing marks for the first frame, a
 * moving-average frame meter, and renderer.info (draw calls, triangles). All of it is cheap enough to stay
 * on in production; the readout lives in the development harness only.
 */

export const MARK_MOUNT = 'scene:mount';
export const MARK_FIRST_FRAME = 'scene:first-frame';
export const MEASURE_FIRST_FRAME = 'scene:time-to-first-frame';

let firstFrameMarked = false;

/** Called when the scene module mounts; resets the first-frame measurement. */
export function markSceneMount(): void {
  firstFrameMarked = false;
  if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return;
  performance.clearMarks(MARK_MOUNT);
  performance.clearMarks(MARK_FIRST_FRAME);
  performance.clearMeasures(MEASURE_FIRST_FRAME);
  performance.mark(MARK_MOUNT);
}

/** Called after every frame; the first call records the time to first frame. Returns it (ms) once, else null. */
export function markFirstFrame(): number | null {
  if (firstFrameMarked || typeof performance === 'undefined' || typeof performance.mark !== 'function')
    return null;
  firstFrameMarked = true;
  performance.mark(MARK_FIRST_FRAME);
  try {
    return performance.measure(MEASURE_FIRST_FRAME, MARK_MOUNT, MARK_FIRST_FRAME).duration;
  } catch {
    return null; // the mount mark was cleared: nothing to measure against
  }
}

/** Frame times over a sliding window, giving the average FPS and the worst frame. */
export class FrameMeter {
  private readonly times: Float32Array;
  private index = 0;
  private filled = 0;

  constructor(readonly windowSize = 90) {
    this.times = new Float32Array(windowSize);
  }

  /** Records the duration of a frame in seconds. */
  push(deltaSeconds: number): void {
    this.times[this.index] = deltaSeconds;
    this.index = (this.index + 1) % this.windowSize;
    this.filled = Math.min(this.filled + 1, this.windowSize);
  }

  get frames(): number {
    return this.filled;
  }

  /** Average frames per second over the window (0 before the first frame). */
  get fps(): number {
    if (this.filled === 0) return 0;
    let total = 0;
    for (let i = 0; i < this.filled; i += 1) total += this.times[i] ?? 0;
    return total > 0 ? this.filled / total : 0;
  }

  /** Longest frame in the window, in milliseconds. */
  get worstMs(): number {
    let worst = 0;
    for (let i = 0; i < this.filled; i += 1) worst = Math.max(worst, this.times[i] ?? 0);
    return worst * 1000;
  }

  reset(): void {
    this.index = 0;
    this.filled = 0;
  }
}

export interface RendererStats {
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
}

/** Reads renderer.info; writes into `out` when given (it runs every frame), so nothing is allocated. */
export function readRendererStats(
  renderer: Pick<WebGLRenderer, 'info'>,
  out: RendererStats = { calls: 0, triangles: 0, geometries: 0, textures: 0 },
): RendererStats {
  const { render, memory } = renderer.info;
  out.calls = render.calls;
  out.triangles = render.triangles;
  out.geometries = memory.geometries;
  out.textures = memory.textures;
  return out;
}

export interface PerfSnapshot {
  fps: number;
  worstMs: number;
  timeToFirstFrameMs: number | null;
  stats: RendererStats;
  /** UNMASKED_RENDERER_WEBGL, or 'unknown'. */
  renderer: string;
  /** True when the renderer is a software rasterizer: the numbers are not representative of a GPU. */
  software: boolean;
}

export function isSoftwareRenderer(name: string): boolean {
  return /swiftshader|llvmpipe|software|softpipe/i.test(name);
}

/** Module-level stats written by the scene's probe and read by the development harness. */
export const perfState: {
  meter: FrameMeter;
  timeToFirstFrameMs: number | null;
  stats: RendererStats;
  renderer: string;
} = {
  meter: new FrameMeter(90),
  timeToFirstFrameMs: null,
  stats: { calls: 0, triangles: 0, geometries: 0, textures: 0 },
  renderer: 'unknown',
};

export function snapshotPerf(): PerfSnapshot {
  return {
    fps: perfState.meter.fps,
    worstMs: perfState.meter.worstMs,
    timeToFirstFrameMs: perfState.timeToFirstFrameMs,
    stats: perfState.stats,
    renderer: perfState.renderer,
    software: isSoftwareRenderer(perfState.renderer),
  };
}
