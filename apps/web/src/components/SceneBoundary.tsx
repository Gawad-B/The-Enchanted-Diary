import { Component, createRef, type ErrorInfo, type ReactNode } from 'react';
import { settingsStore } from '../state/settingsStore';

interface SceneBoundaryProps {
  /** The lazy scene mount, already wrapped in Suspense by the caller. */
  children: ReactNode;
  /** The simple 2D presenter, shown instead when the scene fails. */
  fallback: ReactNode;
}

interface SceneBoundaryState {
  failed: boolean;
}

/**
 * Isolates the 3D scene: if it throws while rendering, or the browser reports a lost WebGL context, the
 * session switches to the simple view (`forcedSimple`, never persisted) and this boundary shows `fallback`.
 * The notice with "Try the immersive view again" is rendered by the shell from `forcedSimple`.
 */
export class SceneBoundary extends Component<SceneBoundaryProps, SceneBoundaryState> {
  override state: SceneBoundaryState = { failed: false };
  private readonly container = createRef<HTMLDivElement>();

  static getDerivedStateFromError(): SceneBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[SceneBoundary]', error, info.componentStack);
    settingsStore.getState().setForcedSimple(error.message);
  }

  /** `webglcontextlost` does not bubble, so it is observed in the capture phase on the wrapper. */
  private readonly onContextLost = (): void => {
    settingsStore.getState().setForcedSimple('The WebGL context was lost');
    this.setState({ failed: true });
  };

  override componentDidMount(): void {
    this.container.current?.addEventListener('webglcontextlost', this.onContextLost, true);
  }

  override componentWillUnmount(): void {
    this.container.current?.removeEventListener('webglcontextlost', this.onContextLost, true);
  }

  override render(): ReactNode {
    if (this.state.failed) return this.props.fallback;
    // `display: contents` keeps the wrapper out of the layout while it still sits in the event path.
    return (
      <div ref={this.container} style={{ display: 'contents' }}>
        {this.props.children}
      </div>
    );
  }
}
