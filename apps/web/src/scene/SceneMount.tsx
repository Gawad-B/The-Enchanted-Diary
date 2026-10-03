import { Suspense, lazy, useEffect, useRef } from 'react';
import { OpenDiaryButton } from './OpenDiaryButton';
import { markSceneMount } from './perf';
import { SceneRoot } from './SceneRoot';

// The development harness is imported only in development builds; the production build never contains it.
const DevHarness = import.meta.env.DEV ? lazy(() => import('./dev/DevHarness')) : null;

function harnessRequested(): boolean {
  return typeof location !== 'undefined' && new URLSearchParams(location.search).get('scene') === 'dev';
}

/**
 * The mount point of the 3D presenter. The experience shell loads this module lazily, only when WebGL is
 * available and the view is immersive. It holds the canvas and the DOM that belongs to the scene: the
 * "Open the diary" button and, in development with `?scene=dev`, the harness that forces phases and poses.
 */
export default function SceneMount() {
  useEffect(() => {
    markSceneMount();
  }, []);
  const mount = useRef<HTMLDivElement>(null);
  return (
    <div className="scene-mount" data-testid="scene-mount" ref={mount}>
      <SceneRoot eventSource={mount} />
      <OpenDiaryButton />
      {DevHarness && harnessRequested() && (
        <Suspense fallback={null}>
          <DevHarness />
        </Suspense>
      )}
    </div>
  );
}
