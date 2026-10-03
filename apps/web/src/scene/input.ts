/**
 * Pointer state shared inside the scene: normalised position (-1..1) and velocity, written once per frame by
 * the camera rig and read by the candle (the flame leans away from where the pointer is moving). A plain
 * object so reading it costs nothing and nothing re-renders.
 */
export interface PointerState {
  x: number;
  y: number;
  /** Units per second in normalised coordinates, smoothed. */
  vx: number;
  vy: number;
}

export const pointerState: PointerState = { x: 0, y: 0, vx: 0, vy: 0 };

export function resetPointerState(): void {
  pointerState.x = 0;
  pointerState.y = 0;
  pointerState.vx = 0;
  pointerState.vy = 0;
}
