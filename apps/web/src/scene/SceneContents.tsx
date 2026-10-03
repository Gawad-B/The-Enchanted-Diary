import { PerformanceMonitor } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import type { WebGLRenderer } from 'three';
import { ParchmentPageSource } from '../book/ParchmentPageSource';
import { diarySourceRegistry } from '../book/diaryPages';
import { pageSourceRegistry, parchmentSourceSlot } from '../book/pageSource';
import { DiaryPageSource } from '../diarypage/DiaryPageSource';
import { diaryLayoutStore } from '../diarypage/service';
import { setTextureRenderer } from '../pdf/textureUpload';
import { anchorStore } from '../state/anchorStore';
import { diaryBookStore } from '../state/diaryBook';
import { documentStore } from '../state/documentStore';
import { experienceStore, useExperienceStore } from '../state/experience';
import { readerStore } from '../state/readerStore';
import { settingsStore } from '../state/settingsStore';
import { Book } from './book/Book';
import { INITIAL_SETTLE_SECONDS } from './book/phaseRunner';
import { useBookPresenter } from './book/useBookPresenter';
import { Candle } from './Candle';
import { mountCandleMotion, propsOffstage } from './propsStage';
import { Props } from './Props';
import { CameraRig } from './CameraRig';
import { Dust } from './Dust';
import { LightShaft } from './LightShaft';
import { Lighting } from './Lighting';
import { MagicMotes } from './MagicMotes';
import { markFirstFrame, perfState, readRendererStats } from './perf';
import { PostFX } from './PostFX';
import {
  MAX_STEP_DOWNS,
  QUALITY_TIERS,
  StepDownGate,
  isSceneBusy,
  liveQuality,
  multisamplingFor,
  particleCounts,
  type QualityTier,
} from './quality';
import { Room } from './Room';
import type { SceneAssets } from './sceneAssets';
import { useSceneAssets } from './useSceneAssets';
import { Table } from './Table';
import { registerDevHooks } from './dev/devHooks';

/** renderer.info is reset by hand while the probe runs (see the frame callback below). */
function setInfoAutoReset(renderer: WebGLRenderer, autoReset: boolean): void {
  renderer.info.autoReset = autoReset;
}

export interface SceneContentsProps {
  tier: QualityTier;
  reducedMotion: boolean;
  /** How many times the performance monitor has stepped the quality down. */
  liveStep: number;
  /** Called (once, at a calm moment) when the quality should step down. */
  onStepDown: () => void;
  /** Whether the performance monitor is on (the development harness can turn it off). */
  monitor: boolean;
}

/** The canvas contents: nothing until the procedural assets are built, then the whole world. */
export function SceneContents(props: SceneContentsProps) {
  const gl = useThree((state) => state.gl);
  const assets = useSceneAssets(props.tier, gl);
  if (!assets) return null;
  return <SceneWorld {...props} assets={assets} />;
}

/** Everything inside the canvas: the room, the table, the candle, the light, the particles and the book. */
function SceneWorld({
  tier,
  reducedMotion,
  liveStep,
  onStepDown,
  monitor,
  assets,
}: SceneContentsProps & { assets: SceneAssets }) {
  const spec = QUALITY_TIERS[tier];
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);
  const phase = useExperienceStore((state) => state.phase);
  // The page source: the diary's own parchment faces. A document-backed source replaces it through the registry.
  useEffect(() => {
    const source = new ParchmentPageSource({
      pageWidth: spec.pageTextureWidth,
      language: settingsStore.getState().uiLanguage,
      anisotropy: Math.min(8, gl.capabilities.getMaxAnisotropy()),
    });
    const syncDocument = (): void => {
      const { document } = documentStore.getState();
      source.setDocument(document?.status === 'ready' ? document : null);
    };
    syncDocument();
    source.setDirection(anchorStore.getState().layoutDirection);
    const stopLayout = anchorStore.subscribe((state, previous) => {
      if (state.layoutDirection !== previous.layoutDirection) source.setDirection(state.layoutDirection);
    });
    const stopDocument = documentStore.subscribe((state, previous) => {
      if (state.document !== previous.document) syncDocument();
    });
    const stopSettings = settingsStore.subscribe((state, previous) => {
      if (state.uiLanguage !== previous.uiLanguage) source.setLanguage(state.uiLanguage);
    });
    // The book reads the registry's source: the parchment until a document is loaded, then the PDF-backed source (which
    // keeps the parchment slot as its own parchment, so a scene that remounts, say on a tier change, is picked up).
    const hadSource = pageSourceRegistry.get() !== null;
    if (!hadSource) pageSourceRegistry.set(source);
    parchmentSourceSlot.set(source);
    return () => {
      stopLayout();
      stopDocument();
      stopSettings();
      if (pageSourceRegistry.get() === source) pageSourceRegistry.set(null);
      if (parchmentSourceSlot.get() === source) parchmentSourceSlot.set(null);
      source.dispose();
    };
  }, [spec.pageTextureWidth, gl]);

  // The diary's own pages (global section T): the ruled sheets with the ink of the conversation, drawn from the shared layout.
  useEffect(() => {
    const source = new DiaryPageSource({
      pageWidth: spec.pageTextureWidth,
      layout: diaryLayoutStore,
      book: diaryBookStore,
      direction: anchorStore.getState().layoutDirection,
      anisotropy: Math.min(8, gl.capabilities.getMaxAnisotropy()),
    });
    const stopLayout = anchorStore.subscribe((state, previous) => {
      if (state.layoutDirection !== previous.layoutDirection) source.setDirection(state.layoutDirection);
    });
    diarySourceRegistry.set(source);
    return () => {
      stopLayout();
      if (diarySourceRegistry.get() === source) diarySourceRegistry.set(null);
      source.dispose();
    };
  }, [spec.pageTextureWidth, gl]);

  // New page textures are uploaded to the GPU at idle through this renderer (a first-use upload in the middle of a turn is a stall).
  useEffect(() => {
    setTextureRenderer(gl);
    return () => {
      setTextureRenderer(null);
    };
  }, [gl]);

  const presenter = useBookPresenter(assets, tier, reducedMotion);

  // The candle stands where the layout and the screen shape say, and glides when they change. It starts where the
  // presenter will lay the book out and where the phase wants the props (on the stage or off it), so mounting is not a
  // change: an RTL diary, a remount of the scene, or a mount straight into the reading framing animates nothing.
  const getState = useThree((state) => state.get);
  const candle = useMemo(() => {
    const { size } = getState();
    const { phase: mountPhase } = experienceStore.getState();
    return mountCandleMotion(
      mountPhase,
      readerStore.getState().spread,
      size.width,
      size.height,
      presenter.layoutDirection,
    );
  }, [getState, presenter]);

  // Compile the shader programs in parallel before the first frame needs them (where the browser can), rather than
  // one stall at a time as each material first draws.
  useEffect(() => {
    gl.compileAsync(scene, camera).catch((error: unknown) => {
      console.warn('[diary] the shader programs could not be compiled ahead of time', error);
    });
  }, [gl, scene, camera]);
  const live = liveQuality(tier, liveStep);
  const counts = particleCounts(tier, reducedMotion, live.particleScale);

  useEffect(() => {
    perfState.renderer = (() => {
      const context = gl.getContext();
      const info = context.getExtension('WEBGL_debug_renderer_info');
      const value = info ? (context.getParameter(info.UNMASKED_RENDERER_WEBGL) as unknown) : undefined;
      return typeof value === 'string' ? value : 'unknown';
    })();
    return registerDevHooks({ presenter, assets, gl });
  }, [gl, presenter, assets]);

  // A composer is rebuilt only when nothing is turning and the camera has settled (the same calm the step-down waits for).
  const isCalm = useMemo(
    () => () =>
      !isSceneBusy(experienceStore.getState().phase, presenter.motion.moving, anchorStore.getState().stable),
    [presenter],
  );

  // One cheap probe per frame: the frame meter, the first-frame mark and renderer.info. The composer renders
  // several passes per frame, so info is reset by hand: this callback (negative priority, so it does not take
  // over rendering) reads the previous frame's totals and then clears them.
  useEffect(() => {
    setInfoAutoReset(gl, false);
    return () => {
      setInfoAutoReset(gl, true);
    };
  }, [gl]);
  const frameCounter = useRef(0);
  // A step-down the monitor asks for waits for a calm moment (no turn, riffle, cover, flip or camera move).
  const gate = useMemo(() => new StepDownGate(), []);
  const requestStepDown = useMemo(
    () => () => {
      gate.request();
    },
    [gate],
  );
  useFrame((state, delta) => {
    candle.update(
      state.size.width / Math.max(state.size.height, 1),
      anchorStore.getState().layoutDirection,
      presenter.motion.cover.value,
      // They are out of the way while the book turns itself over (the layout flips at the end of the turn).
      presenter.motion.flipping ||
        propsOffstage(experienceStore.getState().phase, state.size.width, state.size.height),
      delta,
      // No turn-over under reduced motion, nor while the scene is settling in: the layout changes at once, so do they.
      presenter.motion.reducedMotion || presenter.motion.clock < INITIAL_SETTLE_SECONDS,
    );
  }, -3);
  useFrame((state, delta) => {
    perfState.meter.push(delta);
    const first = markFirstFrame();
    if (first !== null) perfState.timeToFirstFrameMs = first;
    frameCounter.current += 1;
    if (frameCounter.current > 1) readRendererStats(state.gl, perfState.stats);
    state.gl.info.reset();
    const busy = isSceneBusy(
      experienceStore.getState().phase,
      presenter.motion.moving,
      anchorStore.getState().stable,
    );
    if (gate.take(busy)) onStepDown();
  }, -1);

  // The scene draws a vignette of its own through post-processing: the stage's CSS one steps aside.
  const drawsVignette = live.postProcessing !== 'none';
  useEffect(() => {
    anchorStore.getState().setSceneVignette(drawsVignette);
    return () => {
      anchorStore.getState().setSceneVignette(false);
    };
  }, [drawsVignette]);

  return (
    <>
      <Room wood={assets.wood} />
      <Table wood={assets.wood} />
      <Candle motion={candle} env={assets.env?.texture ?? null} />
      <Props motion={candle} env={assets.env?.texture ?? null} />
      <Lighting tier={tier} motion={candle} />
      <Dust count={counts.dust} reducedMotion={reducedMotion} motion={candle} />
      <MagicMotes count={counts.motes} reducedMotion={reducedMotion} cover={presenter.motion.cover} />
      {spec.lightShaft && live.postProcessing !== 'none' && <LightShaft motion={candle} />}
      <Book presenter={presenter} />
      <CameraRig reducedMotion={reducedMotion} motion={presenter.motion} />
      {live.postProcessing !== 'none' && (
        <PostFX
          level={live.postProcessing}
          phase={phase}
          multisampling={multisamplingFor(spec)}
          isCalm={isCalm}
        />
      )}
      {monitor && liveStep < MAX_STEP_DOWNS && (
        <PerformanceMonitor ms={250} iterations={8} bounds={() => [38, 120]} onDecline={requestStepDown} />
      )}
    </>
  );
}
