/*
 * The reveal's camera zoom: ONE number the reveal clock writes and the 3D camera reads (it narrows the field of view by it).
 * The clamp lives here and nowhere else: however the clock drives it, the zoom never passes MAX_REVEAL_ZOOM and never moves
 * faster than MAX_REVEAL_ZOOM_RATE per second, so no frame of a reveal or an unveiling can lurch.
 */

export const MAX_REVEAL_ZOOM = 0.38;
/** The largest change of the zoom per second (it takes about a third of a second to cross the whole range). */
export const MAX_REVEAL_ZOOM_RATE = 1.2;

export const revealZoom = { value: 0 };

/** Moves the zoom toward `target` (0..1 of MAX_REVEAL_ZOOM) over `dtMs`; returns the new value. */
export function setRevealZoom(target: number, dtMs: number): number {
  const wanted = Math.min(Math.max(Number.isFinite(target) ? target : 0, 0), 1) * MAX_REVEAL_ZOOM;
  const maxStep = MAX_REVEAL_ZOOM_RATE * (Math.max(dtMs, 0) / 1000);
  const delta = Math.min(Math.max(wanted - revealZoom.value, -maxStep), maxStep);
  revealZoom.value = Math.min(Math.max(revealZoom.value + delta, 0), MAX_REVEAL_ZOOM);
  return revealZoom.value;
}

export function resetRevealZoom(): void {
  revealZoom.value = 0;
}

/** The field of view with the zoom applied (a narrower field is a closer look). */
export function zoomedFov(fov: number, zoom: number): number {
  return fov * (1 - Math.min(Math.max(zoom, 0), MAX_REVEAL_ZOOM));
}
