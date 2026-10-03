import type { Phase } from '../state/experience';
import type { QualitySetting, ResolvedQuality } from '../state/settingsStore';

/*
 * Quality tiers (global section J): every number the scene scales with the device lives here. The tier is
 * chosen once per session (the visitor's setting, a `?quality=` override, or detection); only DPR,
 * post-processing and particle counts may change at runtime (see `liveQuality`), never shadow maps.
 */
export type QualityTier = ResolvedQuality;
export type PostProcessing = 'full' | 'bloom' | 'none';

export interface TierSpec {
  /** Device-pixel-ratio range handed to the canvas: [min, max]. */
  dpr: readonly [number, number];
  antialias: boolean;
  /** PCF-soft shadow map size in pixels, or null for no shadows (a baked blob shadow replaces them). */
  shadowMapSize: number | null;
  dustParticles: number;
  magicMotes: number;
  /** Width in pixels of a rendered page texture. */
  pageTextureWidth: number;
  /** How many page textures are kept alive. */
  pageTextureCache: number;
  /** Side of the procedural textures (wood, leather, paper). */
  proceduralTextureSize: number;
  /** Segments along the width of a leaf (it bends there when it turns). */
  leafSegments: number;
  /** Leaves around the current spread that are real, individually animated meshes. */
  animatedLeaves: number;
  /** full: bloom + depth of field (discovery only) + vignette + grain; bloom: bloom + vignette; none: CSS vignette. */
  postProcessing: PostProcessing;
  /** The cheap volumetric light shaft from the candle. */
  lightShaft: boolean;
}

export const QUALITY_TIERS: Readonly<Record<QualityTier, TierSpec>> = {
  high: {
    dpr: [1, 2],
    antialias: true,
    shadowMapSize: 2048,
    dustParticles: 900,
    magicMotes: 120,
    pageTextureWidth: 1600,
    pageTextureCache: 14,
    proceduralTextureSize: 2048,
    leafSegments: 32,
    animatedLeaves: 6,
    postProcessing: 'full',
    lightShaft: true,
  },
  medium: {
    dpr: [1, 1.5],
    antialias: true,
    shadowMapSize: 1024,
    dustParticles: 400,
    magicMotes: 60,
    pageTextureWidth: 1200,
    pageTextureCache: 10,
    proceduralTextureSize: 1024,
    leafSegments: 24,
    animatedLeaves: 4,
    postProcessing: 'bloom',
    lightShaft: true,
  },
  low: {
    dpr: [1, 1],
    antialias: false,
    shadowMapSize: null,
    dustParticles: 120,
    magicMotes: 0,
    pageTextureWidth: 800,
    pageTextureCache: 6,
    proceduralTextureSize: 512,
    leafSegments: 14,
    animatedLeaves: 2,
    postProcessing: 'none',
    lightShaft: false,
  },
};

/** Reduced motion caps the particle counts (and the particles drift slowly). */
export const REDUCED_MOTION_PARTICLE_CAP = 120;

/** What detection looks at; every field is injectable so the rules are testable without a browser. */
export interface QualityEnvironment {
  /** navigator.deviceMemory in GB; undefined where the browser does not report it. */
  deviceMemory: number | undefined;
  hardwareConcurrency: number | undefined;
  prefersReducedData: boolean;
  coarsePointer: boolean;
  viewportWidth: number;
  /** UNMASKED_RENDERER_WEBGL when the browser exposes it. */
  rendererString: string | undefined;
}

const WEAK_GPU_PATTERN = /Intel|Mali|Adreno/i;
const MEDIUM_VIEWPORT_LIMIT = 1100;

/** The automatic tier (global section J). */
export function detectAutoTier(env: QualityEnvironment): QualityTier {
  const lowMemory = env.deviceMemory !== undefined && env.deviceMemory <= 2;
  const fewCores = env.hardwareConcurrency !== undefined && env.hardwareConcurrency <= 2;
  // A coarse pointer without a memory report is a Safari phone: be careful with it.
  const safariPhone = env.coarsePointer && env.deviceMemory === undefined;
  if (lowMemory || fewCores || env.prefersReducedData || safariPhone) return 'low';

  const modestMemory = env.deviceMemory !== undefined && env.deviceMemory <= 4;
  const weakGpu = env.rendererString !== undefined && WEAK_GPU_PATTERN.test(env.rendererString);
  if (env.coarsePointer || env.viewportWidth < MEDIUM_VIEWPORT_LIMIT || modestMemory || weakGpu)
    return 'medium';
  return 'high';
}

/** The `?quality=low|medium|high` override (used by the end-to-end tests), or null. */
export function parseQualityParam(search: string): QualityTier | null {
  const value = new URLSearchParams(search).get('quality');
  return value === 'low' || value === 'medium' || value === 'high' ? value : null;
}

/** The tier for this session: the URL override wins, then an explicit setting, then detection. */
export function resolveQuality(
  setting: QualitySetting,
  search: string,
  env: QualityEnvironment,
): QualityTier {
  const override = parseQualityParam(search);
  if (override) return override;
  if (setting !== 'auto') return setting;
  return detectAutoTier(env);
}

/** Reads the renderer name from a throwaway WebGL context (released at once), when the browser exposes it. */
export function readRendererString(): string | undefined {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return undefined;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const value = info ? (gl.getParameter(info.UNMASKED_RENDERER_WEBGL) as unknown) : undefined;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the browser's environment for `detectAutoTier`. */
export function readQualityEnvironment(
  rendererString: string | undefined = readRendererString(),
): QualityEnvironment {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const media = (query: string): boolean =>
    typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  return {
    deviceMemory: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : undefined,
    hardwareConcurrency: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : undefined,
    prefersReducedData: media('(prefers-reduced-data: reduce)'),
    coarsePointer: media('(pointer: coarse)'),
    viewportWidth: window.innerWidth,
    rendererString,
  };
}

/** What may change at runtime when the frame rate drops (the performance monitor steps at most twice). */
export interface LiveQuality {
  /** Upper bound of the device pixel ratio. */
  dprMax: number;
  postProcessing: PostProcessing;
  /** Multiplier on dust and mote counts. */
  particleScale: number;
}

export const MAX_STEP_DOWNS = 2;

export function liveQuality(tier: QualityTier, steps: number): LiveQuality {
  const spec = QUALITY_TIERS[tier];
  const level = Math.min(Math.max(Math.round(steps), 0), MAX_STEP_DOWNS);
  if (level === 0) return { dprMax: spec.dpr[1], postProcessing: spec.postProcessing, particleScale: 1 };
  if (level === 1) {
    return {
      dprMax: Math.max(spec.dpr[0], Math.min(spec.dpr[1], 1.25)),
      postProcessing: spec.postProcessing === 'full' ? 'bloom' : spec.postProcessing,
      particleScale: 0.6,
    };
  }
  return { dprMax: spec.dpr[0], postProcessing: 'none', particleScale: 0.35 };
}

/** Dust and mote counts for the tier, the live step and the motion preference. */
export function particleCounts(
  tier: QualityTier,
  reducedMotion: boolean,
  particleScale = 1,
): { dust: number; motes: number } {
  const spec = QUALITY_TIERS[tier];
  const scale = (count: number): number => {
    const scaled = Math.round(count * particleScale);
    return reducedMotion ? Math.min(scaled, REDUCED_MOTION_PARTICLE_CAP) : scaled;
  };
  return { dust: scale(spec.dustParticles), motes: scale(spec.magicMotes) };
}

/** Samples per pixel of the composer's render target: every antialiased tier gets them, not just the highest. */
export function multisamplingFor(spec: Pick<TierSpec, 'antialias'>): number {
  return spec.antialias ? 4 : 0;
}

/** Phases in which a quality step would be seen as a hitch: the book is turning or the reveal is playing. */
const BUSY_PHASES: ReadonlySet<Phase> = new Set(['opening', 'unveiling', 'revealing', 'closing']);

/**
 * Whether a quality step (a canvas resize, a composer swap) would be a visible hitch right now (global section J):
 * a transitional phase, anything of the book tweening (a turn, a riffle, the cover, the direction flip), or the
 * camera still on its way. Positional arguments, because it runs every frame and must not allocate.
 */
export function isSceneBusy(phase: Phase, bookMoving: boolean, cameraSettled: boolean): boolean {
  return BUSY_PHASES.has(phase) || bookMoving || !cameraSettled;
}

/**
 * Holds a step-down the performance monitor asked for until the scene is calm. The monitor reports a decline
 * once; if that moment is mid-turn the request waits and is taken (once) at the first calm frame.
 */
export class StepDownGate {
  private pending = false;

  request(): void {
    this.pending = true;
  }

  /** True exactly once per request, at the first poll that finds the scene calm. */
  take(busy: boolean): boolean {
    if (!this.pending || busy) return false;
    this.pending = false;
    return true;
  }
}
