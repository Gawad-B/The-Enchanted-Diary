/**
 * Calls `onLost` when the canvas's WebGL context is lost while the canvas is on the page: the session then moves to
 * the simple view. A canvas that has already left the page was taken down on purpose (a quality tier change remounts
 * the canvas, and the renderer releases its context as it goes): that is not a failure and is not reported.
 * Returns the function that stops watching.
 */
export function watchContextLoss(canvas: HTMLCanvasElement, onLost: () => void): () => void {
  const listener = (): void => {
    if (!canvas.isConnected) return;
    onLost();
  };
  canvas.addEventListener('webglcontextlost', listener);
  return () => {
    canvas.removeEventListener('webglcontextlost', listener);
  };
}
