import { act, fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/App';
import { ExperienceShell } from '../../src/components/ExperienceShell';
import { anchorStore } from '../../src/state/anchorStore';
import { experienceStore } from '../../src/state/experience';
import { settingsStore } from '../../src/state/settingsStore';
import { SOME_ERROR } from '../fixtures';
import { resetStores } from './helpers';

// The real scene needs WebGL, which jsdom does not have: these tests are about the shell's choice of presenter,
// so the lazy scene module is replaced by a stub with the same mount point.
vi.mock('../../src/scene/SceneMount', () => ({
  default: () => <div className="scene-mount" data-testid="scene-mount" />,
}));

const WEBGL_OK = () => ({ supported: true });
const WEBGL_MISSING = () => ({ supported: false, reason: 'The browser could not create a WebGL context' });

beforeEach(() => {
  resetStores();
});

async function violations(container: Element) {
  const results = await axe.run(container, {
    // jsdom has no layout engine, so colour contrast cannot be measured here (tokens.test.ts checks the palette).
    rules: { 'color-contrast': { enabled: false } },
  });
  return results.violations.map((violation) => `${violation.id}: ${violation.help}`);
}

describe('the stage', () => {
  it('has a live region with the discovery line, a heading, a main landmark and the fan disclaimer', () => {
    render(<ExperienceShell detectWebGL={WEBGL_OK} />);
    const live = screen.getByTestId('live-region');
    expect(live).toHaveAttribute('role', 'status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveTextContent('A closed diary lies on an old wooden table.');
    expect(screen.getByRole('heading', { level: 1, name: 'The Enchanted Diary' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toHaveTextContent(
      'Not an official Warner Bros. or Wizarding World product.',
    );
  });

  it('shows its CSS vignette unless the scene draws its own (never two vignettes)', () => {
    anchorStore.getState().reset();
    const { container } = render(<ExperienceShell detectWebGL={WEBGL_OK} />);
    const stage = container.querySelector('.stage');
    expect(stage).toHaveAttribute('data-vignette', 'css');
    act(() => {
      anchorStore.getState().setSceneVignette(true);
    });
    expect(stage).toHaveAttribute('data-vignette', 'scene');
    act(() => {
      anchorStore.getState().setSceneVignette(false);
    });
    expect(stage).toHaveAttribute('data-vignette', 'css');
  });

  it('announces the phase the experience is in, and leaves an error to its own alert (never twice)', () => {
    render(<ExperienceShell detectWebGL={WEBGL_OK} />);
    act(() => {
      experienceStore.getState().dispatch({ type: 'INTERACT' });
    });
    expect(screen.getByTestId('live-region')).toHaveTextContent('The diary opens.');
    // An error is NOT repeated here: its own role="alert" line says it where it is shown (it used to be announced twice).
    act(() => {
      experienceStore.setState({ error: SOME_ERROR });
    });
    expect(screen.getByTestId('live-region')).toHaveTextContent('The diary opens.');
    expect(screen.getByTestId('live-region')).not.toHaveTextContent('The manuscript could not be opened.');
  });

  it('passes an automated accessibility check in English and Arabic, with and without a notice', async () => {
    const { container, unmount } = render(<ExperienceShell detectWebGL={WEBGL_MISSING} />);
    expect(await violations(container)).toEqual([]);
    act(() => {
      settingsStore.getState().setForcedSimple('The WebGL context was lost');
    });
    expect(await violations(container)).toEqual([]);
    act(() => {
      settingsStore.getState().setUiLanguage('ar');
    });
    expect(await violations(container)).toEqual([]);
    unmount();
  });
});

describe('choosing the presenter', () => {
  it('mounts the lazy 3D scene slot when WebGL is available and the view is immersive', async () => {
    render(<ExperienceShell detectWebGL={WEBGL_OK} />);
    expect(await screen.findByTestId('scene-mount')).toBeInTheDocument();
    expect(screen.queryByTestId('fallback-mount')).not.toBeInTheDocument();
    expect(document.querySelector('.stage')).toHaveAttribute('data-presenter', 'scene');
  });

  it('holds a marked placeholder in the presenter slot from the very first render, and the real mount point replaces it', async () => {
    render(<ExperienceShell detectWebGL={WEBGL_OK} />);
    const slots = () =>
      document.querySelectorAll(
        '[data-testid="scene-mount"], [data-testid="scene-loading"], [data-testid="fallback-mount"]',
      );
    // No waiting: whether or not the lazy module has resolved yet, the slot is there, and only one.
    expect(slots()).toHaveLength(1);
    // The placeholder never poses as the scene: only the loaded module's mount point carries `scene-mount`.
    for (const placeholder of document.querySelectorAll('[data-loading]')) {
      expect(placeholder).toHaveAttribute('data-testid', 'scene-loading');
      expect(placeholder).toHaveStyle({ pointerEvents: 'none' });
    }
    await screen.findByTestId('scene-mount');
    await vi.waitFor(() => {
      expect(slots()).toHaveLength(1);
      expect(document.querySelector('[data-loading]')).toBeNull();
    });
  });

  it('shows the simple view (the welcome) in the 2D fallback and says why when WebGL is missing', () => {
    render(<ExperienceShell detectWebGL={WEBGL_MISSING} />);
    expect(screen.getByTestId('fallback-mount')).toBeInTheDocument();
    expect(screen.queryByTestId('scene-mount')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start revealing the secrets' })).toBeInTheDocument();
    expect(screen.getByText('The browser could not create a WebGL context').tagName).toBe('BDI');
    expect(document.querySelector('.fallback-mount__note')).toHaveTextContent(
      'This browser cannot draw the 3D diary (The browser could not create a WebGL context), so the simple view is showing.',
    );
    expect(document.querySelector('.stage')).toHaveAttribute('data-presenter', 'fallback');
  });

  it('uses the fallback when the reader chose the simple view, without a notice', () => {
    settingsStore.getState().setView('simple');
    render(<ExperienceShell detectWebGL={WEBGL_OK} />);
    expect(screen.getByTestId('fallback-mount')).toBeInTheDocument();
    expect(screen.queryByTestId('scene-mount')).not.toBeInTheDocument();
    expect(screen.queryByText(/immersive view stopped/)).not.toBeInTheDocument();
    expect(screen.queryByText(/cannot draw the 3D diary/)).not.toBeInTheDocument();
  });

  it('shows the notice with the reason when the simple view is forced, and returns to the scene on request', async () => {
    settingsStore.getState().setForcedSimple('The WebGL context was lost');
    render(<ExperienceShell detectWebGL={WEBGL_OK} />);
    expect(screen.getByTestId('fallback-mount')).toBeInTheDocument();
    expect(document.querySelector('.notice')).toHaveTextContent(
      'The immersive view stopped working (The WebGL context was lost). The simple view is showing instead',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try the immersive view again' }));
    expect(settingsStore.getState().forcedSimple).toBeNull();
    expect(await screen.findByTestId('scene-mount')).toBeInTheDocument();
    expect(screen.queryByText(/immersive view stopped/)).not.toBeInTheDocument();
  });

  it('shows the welcome in Arabic, right to left, in an Arabic interface', () => {
    settingsStore.getState().setUiLanguage('ar');
    render(<ExperienceShell detectWebGL={WEBGL_MISSING} />);
    const stage = document.querySelector('.stage');
    expect(stage).toHaveAttribute('dir', 'rtl');
    expect(stage).toHaveAttribute('lang', 'ar');
    expect(screen.getByTestId('live-region')).toHaveTextContent('مذكّرة مغلقة تستقرّ على طاولة خشبية قديمة.');
    expect(screen.getByRole('button', { name: 'ابدأ كشف الأسرار' })).toBeInTheDocument();
  });
});

describe('App', () => {
  it('renders the shell; jsdom has no WebGL, so it is the 2D fallback that shows', () => {
    render(<App />);
    expect(screen.getByTestId('live-region')).toBeInTheDocument();
    expect(screen.getByTestId('fallback-mount')).toBeInTheDocument();
  });
});
