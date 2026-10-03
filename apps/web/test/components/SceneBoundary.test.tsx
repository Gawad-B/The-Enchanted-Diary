import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SceneBoundary } from '../../src/components/SceneBoundary';
import { settingsStore } from '../../src/state/settingsStore';
import { resetStores } from './helpers';

function Throwing(): never {
  throw new Error('scene exploded');
}

let consoleError: { mockRestore(): void };

beforeEach(() => {
  resetStores();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('SceneBoundary', () => {
  it('renders its children and leaves the settings alone while the scene works', () => {
    render(
      <SceneBoundary fallback={<p>simple view</p>}>
        <p>the scene</p>
      </SceneBoundary>,
    );
    expect(screen.getByText('the scene')).toBeInTheDocument();
    expect(screen.queryByText('simple view')).not.toBeInTheDocument();
    expect(settingsStore.getState().forcedSimple).toBeNull();
  });

  it('shows the fallback and forces the simple view when the scene throws', () => {
    render(
      <SceneBoundary fallback={<p>simple view</p>}>
        <Throwing />
      </SceneBoundary>,
    );
    expect(screen.getByText('simple view')).toBeInTheDocument();
    expect(settingsStore.getState().forcedSimple).toEqual({ reason: 'scene exploded' });
    expect(consoleError).toHaveBeenCalled(); // the error is logged, not swallowed
  });

  it('does not persist the forced simple view', () => {
    render(
      <SceneBoundary fallback={<p>simple view</p>}>
        <Throwing />
      </SceneBoundary>,
    );
    expect(settingsStore.getState().view).toBe('immersive'); // the saved preference is untouched
  });

  it('switches to the fallback when the WebGL context is lost', () => {
    render(
      <SceneBoundary fallback={<p>simple view</p>}>
        <canvas data-testid="canvas" />
      </SceneBoundary>,
    );
    expect(screen.getByTestId('canvas')).toBeInTheDocument();
    // webglcontextlost does not bubble: the boundary has to listen in the capture phase.
    fireEvent(
      screen.getByTestId('canvas'),
      new Event('webglcontextlost', { bubbles: false, cancelable: true }),
    );
    expect(screen.getByText('simple view')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas')).not.toBeInTheDocument();
    expect(settingsStore.getState().forcedSimple).toEqual({ reason: 'The WebGL context was lost' });
  });

  it('stops listening for context loss when it unmounts', () => {
    const { unmount } = render(
      <SceneBoundary fallback={<p>simple view</p>}>
        <canvas data-testid="canvas" />
      </SceneBoundary>,
    );
    const canvas = screen.getByTestId('canvas');
    unmount();
    canvas.dispatchEvent(new Event('webglcontextlost'));
    expect(settingsStore.getState().forcedSimple).toBeNull();
  });
});
