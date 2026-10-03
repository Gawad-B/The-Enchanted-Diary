export interface WebGLSupport {
  supported: boolean;
  /** Why it is unsupported, for the technical line shown with the 2D fallback. */
  reason?: string;
}

/**
 * Whether this browser can create a WebGL context at all. It creates a throwaway context (WebGL2, then
 * WebGL1) and releases it immediately through WEBGL_lose_context, so the probe does not use up one of the
 * browser's few simultaneous contexts.
 */
export function detectWebGL(): WebGLSupport {
  if (typeof document === 'undefined') return { supported: false, reason: 'No document available' };
  try {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!context) return { supported: false, reason: 'The browser could not create a WebGL context' };
    context.getExtension('WEBGL_lose_context')?.loseContext();
    return { supported: true };
  } catch (error) {
    return { supported: false, reason: error instanceof Error ? error.message : 'WebGL detection failed' };
  }
}
