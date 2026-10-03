import { useEffect, useState } from 'react';
import type { WebGLRenderer } from 'three';
import { runBuild } from '../lib/buildScheduler';
import type { QualityTier } from './quality';
import { buildSceneAssets, domCanvas, type SceneAssets } from './sceneAssets';
import { createStudioEnvironment } from './studioEnvironment';

/**
 * The scene's procedural assets, built a step at a time after mount (the page stays responsive while the textures
 * are drawn) and disposed with the mount. Created in an effect, never in a render, so React's development double
 * mount builds (and cancels, and disposes) cleanly instead of leaking a discarded set. Null until built.
 */
export function useSceneAssets(tier: QualityTier, gl: WebGLRenderer): SceneAssets | null {
  const [assets, setAssets] = useState<SceneAssets | null>(null);
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  // A build that throws is rethrown here, in render, where the scene's error boundary catches it (the session falls back
  // to the simple view and says why) instead of leaving a stage that is blank for good.
  if (failure) throw failure.error instanceof Error ? failure.error : new Error(String(failure.error));
  useEffect(() => {
    const anisotropy = Math.min(8, gl.capabilities.getMaxAnisotropy());
    let built: SceneAssets | null = null;
    let live = true;
    const env = createStudioEnvironment(gl);
    const cancel = runBuild(
      buildSceneAssets(tier, anisotropy, domCanvas, env),
      (result) => {
        if (!live) {
          result.dispose();
          return;
        }
        built = result;
        setAssets(result);
      },
      undefined,
      (error) => {
        if (live) setFailure({ error });
      },
    );
    return () => {
      live = false;
      cancel();
      if (built) built.dispose();
      else env?.dispose(); // cancelled before the build finished: the environment is still ours to release
    };
  }, [tier, gl]);
  return assets;
}
