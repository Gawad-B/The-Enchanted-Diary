import { describe, expect, it } from 'vitest';
import {
  detectAutoTier,
  isSceneBusy,
  liveQuality,
  multisamplingFor,
  MAX_STEP_DOWNS,
  parseQualityParam,
  particleCounts,
  QUALITY_TIERS,
  readQualityEnvironment,
  resolveQuality,
  StepDownGate,
  type QualityEnvironment,
} from '../../src/scene/quality';

const desktop: QualityEnvironment = {
  deviceMemory: 8,
  hardwareConcurrency: 8,
  prefersReducedData: false,
  coarsePointer: false,
  viewportWidth: 1920,
  rendererString: 'NVIDIA GeForce RTX 3060',
};
const env = (overrides: Partial<QualityEnvironment>): QualityEnvironment => ({ ...desktop, ...overrides });

describe('the tier table (global section J)', () => {
  it('has the exact numbers of the specification', () => {
    expect(QUALITY_TIERS.high).toMatchObject({
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
    });
    expect(QUALITY_TIERS.medium).toMatchObject({
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
    });
    expect(QUALITY_TIERS.low).toMatchObject({
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
    });
  });
});

describe('detectAutoTier', () => {
  it('a strong desktop is high', () => {
    expect(detectAutoTier(desktop)).toBe('high');
  });

  it('low memory (2 GB or less), two cores or fewer, or reduced data is low', () => {
    expect(detectAutoTier(env({ deviceMemory: 2 }))).toBe('low');
    expect(detectAutoTier(env({ deviceMemory: 1 }))).toBe('low');
    expect(detectAutoTier(env({ hardwareConcurrency: 2 }))).toBe('low');
    expect(detectAutoTier(env({ hardwareConcurrency: 1 }))).toBe('low');
    expect(detectAutoTier(env({ prefersReducedData: true }))).toBe('low');
  });

  it('a coarse pointer with no memory report (a Safari phone) is low', () => {
    expect(detectAutoTier(env({ coarsePointer: true, deviceMemory: undefined, viewportWidth: 390 }))).toBe(
      'low',
    );
  });

  it('a coarse pointer that reports its memory is medium', () => {
    expect(detectAutoTier(env({ coarsePointer: true, deviceMemory: 8, viewportWidth: 820 }))).toBe('medium');
  });

  it('a viewport under 1100 px, 4 GB of memory or less, or an Intel, Mali or Adreno renderer is medium', () => {
    expect(detectAutoTier(env({ viewportWidth: 1099 }))).toBe('medium');
    expect(detectAutoTier(env({ viewportWidth: 1100 }))).toBe('high');
    expect(detectAutoTier(env({ deviceMemory: 4 }))).toBe('medium');
    expect(detectAutoTier(env({ deviceMemory: 8 }))).toBe('high');
    expect(
      detectAutoTier(env({ rendererString: 'ANGLE (Intel, Mesa Intel(R) Xe Graphics (TGL GT2))' })),
    ).toBe('medium');
    expect(detectAutoTier(env({ rendererString: 'Mali-G78' }))).toBe('medium');
    expect(detectAutoTier(env({ rendererString: 'Adreno (TM) 650' }))).toBe('medium');
  });

  it('a browser that reports nothing is judged by the viewport alone', () => {
    const unknown = env({
      deviceMemory: undefined,
      hardwareConcurrency: undefined,
      rendererString: undefined,
    });
    expect(detectAutoTier(unknown)).toBe('high');
    expect(detectAutoTier({ ...unknown, viewportWidth: 800 })).toBe('medium');
  });

  it('low wins over medium when both apply', () => {
    expect(detectAutoTier(env({ deviceMemory: 2, viewportWidth: 600, coarsePointer: true }))).toBe('low');
  });
});

describe('the quality override and setting', () => {
  it('?quality= accepts low, medium and high only', () => {
    expect(parseQualityParam('?quality=low')).toBe('low');
    expect(parseQualityParam('?a=1&quality=high')).toBe('high');
    expect(parseQualityParam('?quality=medium')).toBe('medium');
    expect(parseQualityParam('?quality=ultra')).toBeNull();
    expect(parseQualityParam('')).toBeNull();
  });

  it('the URL override beats the setting, the setting beats detection', () => {
    expect(resolveQuality('high', '?quality=low', desktop)).toBe('low');
    expect(resolveQuality('medium', '', desktop)).toBe('medium');
    expect(resolveQuality('auto', '', desktop)).toBe('high');
    expect(resolveQuality('auto', '', env({ deviceMemory: 1 }))).toBe('low');
  });
});

describe('readQualityEnvironment (mocked navigator)', () => {
  it('reads memory, cores, media queries and the viewport', () => {
    const originals = {
      matchMedia: window.matchMedia,
      memory: Object.getOwnPropertyDescriptor(navigator, 'deviceMemory'),
      cores: Object.getOwnPropertyDescriptor(navigator, 'hardwareConcurrency'),
    };
    Object.defineProperty(navigator, 'deviceMemory', { value: 4, configurable: true });
    Object.defineProperty(navigator, 'hardwareConcurrency', { value: 6, configurable: true });
    window.matchMedia = (query: string) => ({ matches: query.includes('pointer: coarse') }) as MediaQueryList;
    try {
      const read = readQualityEnvironment('Mali-G57');
      expect(read).toMatchObject({
        deviceMemory: 4,
        hardwareConcurrency: 6,
        prefersReducedData: false,
        coarsePointer: true,
        rendererString: 'Mali-G57',
      });
      expect(read.viewportWidth).toBe(window.innerWidth);
    } finally {
      window.matchMedia = originals.matchMedia;
      if (originals.memory) Object.defineProperty(navigator, 'deviceMemory', originals.memory);
      else Reflect.deleteProperty(navigator, 'deviceMemory');
      if (originals.cores) Object.defineProperty(navigator, 'hardwareConcurrency', originals.cores);
    }
  });

  it('a missing deviceMemory stays undefined', () => {
    expect(readQualityEnvironment(undefined).deviceMemory).toBeUndefined();
  });
});

describe('live quality (what the performance monitor may change)', () => {
  it('step 0 is the tier as specified', () => {
    expect(liveQuality('high', 0)).toEqual({ dprMax: 2, postProcessing: 'full', particleScale: 1 });
    expect(liveQuality('medium', 0)).toEqual({ dprMax: 1.5, postProcessing: 'bloom', particleScale: 1 });
  });

  it('step 1 lowers the pixel ratio, drops depth of field and grain, thins the particles', () => {
    expect(liveQuality('high', 1)).toEqual({ dprMax: 1.25, postProcessing: 'bloom', particleScale: 0.6 });
    expect(liveQuality('medium', 1).dprMax).toBe(1.25);
    expect(liveQuality('low', 1).dprMax).toBe(1);
  });

  it('step 2 is the floor: pixel ratio 1, no post-processing; there is no step 3', () => {
    expect(liveQuality('high', 2)).toEqual({ dprMax: 1, postProcessing: 'none', particleScale: 0.35 });
    expect(MAX_STEP_DOWNS).toBe(2);
    expect(liveQuality('high', 9)).toEqual(liveQuality('high', 2));
    expect(liveQuality('high', -1)).toEqual(liveQuality('high', 0));
  });

  it('only the three allowed things change, never the shadow map or the textures', () => {
    expect(Object.keys(liveQuality('high', 1)).sort()).toEqual(['dprMax', 'particleScale', 'postProcessing']);
  });
});

describe('particleCounts', () => {
  it('uses the tier counts', () => {
    expect(particleCounts('high', false)).toEqual({ dust: 900, motes: 120 });
    expect(particleCounts('medium', false)).toEqual({ dust: 400, motes: 60 });
    expect(particleCounts('low', false)).toEqual({ dust: 120, motes: 0 });
  });

  it('scales with the live step and caps at 120 under reduced motion', () => {
    expect(particleCounts('high', false, 0.5)).toEqual({ dust: 450, motes: 60 });
    expect(particleCounts('high', true)).toEqual({ dust: 120, motes: 120 });
    expect(particleCounts('low', true)).toEqual({ dust: 120, motes: 0 });
    expect(particleCounts('medium', true, 0.1)).toEqual({ dust: 40, motes: 6 });
  });
});

describe('anti-aliasing follows the tier, not just the high tier', () => {
  it('multisamples the composer whenever the tier is antialiased', () => {
    expect(multisamplingFor(QUALITY_TIERS.high)).toBe(4);
    expect(multisamplingFor(QUALITY_TIERS.medium)).toBe(4);
    expect(multisamplingFor(QUALITY_TIERS.low)).toBe(0);
  });
});

describe('when a quality step may be taken', () => {
  it('never while the book moves (a turn or a riffle, the cover, the flip) or the camera is on its way', () => {
    expect(isSceneBusy('manuscript', false, true)).toBe(false);
    expect(isSceneBusy('manuscript', true, true)).toBe(true);
    expect(isSceneBusy('manuscript', false, false)).toBe(true);
  });

  it('never in a transitional phase', () => {
    for (const phase of ['opening', 'unveiling', 'revealing', 'closing'] as const) {
      expect(isSceneBusy(phase, false, true), phase).toBe(true);
    }
    for (const phase of ['discovery', 'awaiting', 'uploading', 'reading', 'manuscript', 'memory'] as const) {
      expect(isSceneBusy(phase, false, true), phase).toBe(false);
    }
  });

  it('a decline that arrives mid-turn is deferred until the scene is calm, and then taken once', () => {
    const gate = new StepDownGate();
    expect(gate.take(false)).toBe(false);
    gate.request();
    expect(gate.take(true)).toBe(false);
    expect(gate.take(true)).toBe(false);
    expect(gate.take(false)).toBe(true);
    expect(gate.take(false)).toBe(false);
  });

  it('several declines in a row (while busy) still cost only one step', () => {
    const gate = new StepDownGate();
    gate.request();
    gate.request();
    gate.request();
    expect(gate.take(false)).toBe(true);
    expect(gate.take(false)).toBe(false);
  });
});
