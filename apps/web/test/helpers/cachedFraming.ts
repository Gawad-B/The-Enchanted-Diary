import { framingFor, type CameraPose, type FramingContext } from '../../src/scene/cameraFraming';

/**
 * `framingFor`, remembered by what it depends on: the sweep tests ask for the same pose for every prop, every corner of the
 * camera's reach and every frame, and a reading framing (which holds the leaves' outline) is not free to work out.
 */
const poses = new Map<string, CameraPose>();

export function framingForCached(context: FramingContext): CameraPose {
  const key = [
    context.phase,
    context.width,
    context.height,
    context.direction,
    context.leafCount,
    context.focusSide ?? '-',
  ].join('|');
  const known = poses.get(key);
  if (known) return known;
  const pose = framingFor(context);
  poses.set(key, pose);
  return pose;
}
