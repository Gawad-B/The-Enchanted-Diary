import { Canvas, type RootState } from '@react-three/fiber';
import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react';
import { ACESFilmicToneMapping, PCFShadowMap, SRGBColorSpace } from 'three';
import { settingsStore, useSettingsStore } from '../state/settingsStore';
import {
  MAX_STEP_DOWNS,
  QUALITY_TIERS,
  liveQuality,
  readQualityEnvironment,
  resolveQuality,
} from './quality';
import { watchContextLoss } from './contextLoss';
import { SceneContents } from './SceneContents';
import { pageEffectsStore } from '../state/pageEffectsStore';

/**
 * The 3D scene's canvas (loaded as its own chunk). It picks the quality tier once per session, hands the
 * canvas the tier's pixel ratio, antialiasing and shadows, renders with ACES filmic tone mapping to sRGB,
 * pauses the render loop while the tab is hidden, reports a lost WebGL context so the session falls back to the
 * simple view, and lets the performance monitor step the quality down at most twice, never during a turn.
 */

function isTabHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

export interface SceneRootProps {
  /**
   * The element the canvas listens to for pointer events: the whole stage mount, so the pointer is tracked
   * (parallax, the candle's lean, hover) even while it is over the DOM button laid on the book.
   */
  eventSource: RefObject<HTMLElement | null>;
}

/** Pointer position in the canvas's own normalised coordinates, whatever element the event came from. */
function computePointer(event: MouseEvent, state: RootState): void {
  const { left, top, width, height } = state.size;
  state.pointer.set(((event.clientX - left) / width) * 2 - 1, -((event.clientY - top) / height) * 2 + 1);
  state.raycaster.setFromCamera(state.pointer, state.camera);
}

export function SceneRoot({ eventSource }: SceneRootProps) {
  const quality = useSettingsStore((state) => state.quality);
  const reducedMotion = useSettingsStore((state) => state.reducedMotionResolved);
  const tier = useMemo(
    () =>
      resolveQuality(
        quality,
        typeof location === 'undefined' ? '' : location.search,
        readQualityEnvironment(),
      ),
    [quality],
  );
  useEffect(() => {
    settingsStore.getState().setResolvedQuality(tier);
    return () => {
      settingsStore.getState().setResolvedQuality(null);
    };
  }, [tier]);

  const [hidden, setHidden] = useState(isTabHidden);
  useEffect(() => {
    const onChange = (): void => {
      setHidden(isTabHidden());
    };
    document.addEventListener('visibilitychange', onChange);
    return () => {
      document.removeEventListener('visibilitychange', onChange);
    };
  }, []);

  // Steps belong to a tier: a new tier is a new scene and starts again from the top.
  const [live, setLive] = useState({ tier, steps: 0 });
  const liveStep = live.tier === tier ? live.steps : 0;
  const onStepDown = useCallback(() => {
    setLive((previous) => {
      const steps = previous.tier === tier ? previous.steps : 0;
      return steps >= MAX_STEP_DOWNS ? previous : { tier, steps: steps + 1 };
    });
  }, [tier]);

  const monitorEnabled = useMemo(
    () =>
      !(
        import.meta.env.DEV &&
        typeof location !== 'undefined' &&
        new URLSearchParams(location.search).get('monitor') === 'off'
      ),
    [],
  );

  const spec = QUALITY_TIERS[tier];
  const liveSpec = liveQuality(tier, liveStep);
  const onCreated = useCallback((state: RootState) => {
    const canvas = state.gl.domElement;
    canvas.setAttribute('aria-hidden', 'true');
    state.setEvents({ compute: computePointer });
    watchContextLoss(canvas, () => {
      // The session continues in the simple view; the shell explains why and offers the way back.
      pageEffectsStore.getState().clearAll();
      settingsStore.getState().setForcedSimple('The WebGL context was lost');
    });
  }, []);

  return (
    <Canvas
      // A new tier is a new scene (antialiasing and shadow type cannot change on a live context): remount.
      key={tier}
      aria-hidden="true"
      eventSource={eventSource}
      frameloop={hidden ? 'never' : 'always'}
      dpr={[spec.dpr[0], liveSpec.dprMax]}
      shadows={spec.shadowMapSize !== null ? { type: PCFShadowMap } : false}
      camera={{ fov: 38, near: 0.05, far: 60, position: [0, 5, 7] }}
      gl={{
        antialias: spec.antialias,
        powerPreference: 'high-performance',
        alpha: false,
        stencil: false,
        // Development only (`?preserve=1`): lets the QA scripts read the canvas when a software renderer is too slow
        // for the compositor to deliver a frame to a screenshot.
        preserveDrawingBuffer:
          import.meta.env.DEV && typeof location !== 'undefined' && location.search.includes('preserve=1'),
        toneMapping: ACESFilmicToneMapping,
        outputColorSpace: SRGBColorSpace,
      }}
      onCreated={onCreated}
      style={{ position: 'absolute', inset: 0 }}
    >
      <SceneContents
        tier={tier}
        reducedMotion={reducedMotion}
        liveStep={liveStep}
        onStepDown={onStepDown}
        monitor={monitorEnabled}
      />
    </Canvas>
  );
}
