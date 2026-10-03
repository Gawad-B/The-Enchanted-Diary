import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExperienceShell } from '../../src/components/ExperienceShell';
import { settingsStore } from '../../src/state/settingsStore';
import { resetStores } from './helpers';

// The scene mount throws, as a broken WebGL scene would. The shell must fall back instead of crashing.
vi.mock('../../src/scene/SceneMount', () => ({
  default: () => {
    throw new Error('shader compilation failed');
  },
}));

let consoleError: { mockRestore(): void };

beforeEach(() => {
  resetStores();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('a scene that throws', () => {
  it('falls back to the 2D view with a notice naming the reason and the way back', async () => {
    render(<ExperienceShell detectWebGL={() => ({ supported: true })} />);
    expect(await screen.findByTestId('fallback-mount')).toBeInTheDocument();
    expect(document.querySelector('.notice')).toHaveTextContent(
      'The immersive view stopped working (shader compilation failed).',
    );
    expect(screen.getByRole('button', { name: 'Try the immersive view again' })).toBeInTheDocument();
    expect(settingsStore.getState().forcedSimple).toEqual({ reason: 'shader compilation failed' });
    expect(document.querySelector('.stage')).toHaveAttribute('data-presenter', 'fallback');
  });
});
