import { useFrame } from '@react-three/fiber';
import { useEffect, useState } from 'react';
import { QUALITY_TIERS, type QualityTier } from '../quality';
import type { SceneAssets } from '../sceneAssets';
import { BookPresenter } from './bookPresenter';
import { BookRig } from './bookRig';

export { BookPresenter, desiredDirection } from './bookPresenter';

/** Leaves allowed in the air at once, by tier (the riffle's budget). */
export function maxAirborneFor(tier: QualityTier): number {
  return tier === 'high' ? 5 : tier === 'medium' ? 4 : 3;
}

/**
 * Creates the 3D presenter for a scene mount and runs it every frame. All the logic lives in BookPresenter;
 * this hook only ties its life to the component and its frame to the render loop.
 */
export function useBookPresenter(
  assets: SceneAssets,
  tier: QualityTier,
  reducedMotion: boolean,
): BookPresenter {
  const [presenter] = useState(
    () =>
      new BookPresenter({
        rig: new BookRig(assets.book, QUALITY_TIERS[tier].animatedLeaves),
        maxAirborne: maxAirborneFor(tier),
        reducedMotion,
      }),
  );

  useEffect(() => {
    const detach = presenter.attach();
    presenter.rig.requestWarmUp();
    return () => {
      detach();
      presenter.dispose();
    };
  }, [presenter]);

  useFrame((state, delta) => {
    presenter.frame(state.clock.elapsedTime, delta);
  });

  return presenter;
}
