import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STRINGS } from '../../src/i18n/strings';
import { revealStore } from '../../src/reveal/revealStore';
import { experienceStore } from '../../src/state/experience';
import { settingsStore } from '../../src/state/settingsStore';
import { SettingsMenu } from '../../src/ui/settings/SettingsMenu';
import { TruthScene } from '../../src/ui/truth/TruthScene';

const page = (n: number) => ({ page: n, rects: [] });

beforeEach(() => {
  settingsStore.getState().setUiLanguage('en');
  settingsStore.getState().setReducedMotion('no-preference');
  settingsStore.getState().setSound(false);
});
afterEach(() => {
  revealStore.getState().reset();
  experienceStore.setState({ phase: 'discovery' });
});

function begin(language: 'en' | 'ar', pages = [page(12), page(30)]) {
  act(() => {
    experienceStore.setState({ phase: 'revealing' });
    revealStore.getState().begin(pages, language, 1);
  });
}

describe('the truth scene', () => {
  it('renders nothing until a scene has begun', () => {
    render(<TruthScene />);
    expect(screen.queryByTestId('truth-scene')).toBeNull();
  });

  it('writes the diary line in the language of the question (a word at a time in Arabic)', () => {
    render(<TruthScene />);
    begin('ar');
    act(() => {
      revealStore.getState().setBeat('line', 1);
    });
    const line = screen.getByTestId('truth-line');
    expect(line).toHaveAttribute('lang', 'ar');
    expect(line).toHaveAttribute('dir', 'rtl');
    expect(line).toHaveAccessibleName(STRINGS.ar.diary.showTruthLine);
    expect(line.textContent).toBe(STRINGS.ar.diary.showTruthLine);
  });

  it('shows the cited page as a dialog with the return ribbon (enabled once the memory is reached) and next-page arrows', () => {
    render(<TruthScene />);
    begin('en');
    act(() => {
      revealStore.getState().setBeat('page', 1);
    });
    expect(screen.getByRole('dialog', { name: STRINGS.en.truth.dialogLabel })).toBeInTheDocument();
    expect(screen.getByTestId('truth-caption')).toHaveTextContent('Page 12');
    expect(screen.getByTestId('truth-return')).toBeDisabled();
    act(() => {
      experienceStore.setState({ phase: 'memory' });
    });
    expect(screen.getByTestId('truth-return')).toBeEnabled();
    expect(screen.getByTestId('truth-return')).toHaveFocus();
    expect(screen.getByTestId('truth-prev')).toBeDisabled();
    fireEvent.click(screen.getByTestId('truth-next'));
    expect(revealStore.getState().index).toBe(1);
    expect(screen.getByTestId('truth-caption')).toHaveTextContent('Page 30');
    expect(screen.getByTestId('truth-next')).toBeDisabled();
  });

  it('a single citation has no next-page arrows; Arabic chrome uses Arabic digits and words', () => {
    settingsStore.getState().setUiLanguage('ar');
    render(<TruthScene />);
    begin('ar', [page(12)]);
    act(() => {
      revealStore.getState().setBeat('page', 1);
      experienceStore.setState({ phase: 'memory' });
    });
    expect(screen.queryByTestId('truth-next')).toBeNull();
    expect(screen.getByTestId('truth-caption')).toHaveTextContent('صفحة ١٢');
    expect(screen.getByTestId('truth-return')).toHaveTextContent(STRINGS.ar.truth.returnToPage);
  });

  it('draws the page picture it is given and says so honestly when it cannot', () => {
    render(<TruthScene />);
    begin('en');
    const canvas = document.createElement('canvas');
    act(() => {
      revealStore.getState().setBeat('page', 1);
      revealStore.getState().setImage({ page: 12, canvas });
    });
    expect(screen.getByTestId('truth-page').contains(canvas)).toBe(true);
    act(() => {
      revealStore.getState().setIndex(1);
      revealStore.getState().setImageFailed(true);
    });
    expect(screen.getByText(STRINGS.en.truth.imageFailed)).toBeInTheDocument();
  });

  it('shows Skip while the scene runs and not in the memory', () => {
    render(<TruthScene />);
    begin('en');
    act(() => {
      revealStore.getState().setBeat('riffle', 0.5);
    });
    expect(screen.getByTestId('truth-skip')).toHaveTextContent(STRINGS.en.truth.skip);
    act(() => {
      experienceStore.setState({ phase: 'memory' });
    });
    expect(screen.queryByTestId('truth-skip')).toBeNull();
  });

  it('Escape in the memory returns to the diary page, through the conductor', async () => {
    const effects = await import('../../src/state/effects/reveal');
    const stop = effects.startRevealEffect({
      experience: experienceStore,
      reveal: revealStore,
    });
    render(<TruthScene />);
    act(() => {
      experienceStore.setState({ phase: 'memory' });
      revealStore.getState().begin([page(12)], 'en', 1);
      revealStore.getState().setBeat('page', 1);
    });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(experienceStore.getState().phase).toBe('manuscript');
    stop();
  });
});

describe('the settings control', () => {
  it('is one icon button that opens sound, reduced motion and language; each is labelled and pressed-state aware', () => {
    render(<SettingsMenu />);
    const button = screen.getByRole('button', { name: STRINGS.en.settings.button });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const sound = screen.getByTestId('setting-sound');
    expect(sound).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(sound);
    expect(settingsStore.getState().sound).toBe(true);
    expect(screen.getByTestId('setting-sound')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('setting-motion-reduce'));
    expect(settingsStore.getState().reducedMotion).toBe('reduce');
    expect(settingsStore.getState().reducedMotionResolved).toBe(true);
    fireEvent.click(screen.getByTestId('setting-motion-system'));
    expect(settingsStore.getState().reducedMotion).toBe('system');
  });

  it('switches the interface language to Arabic and back, and Escape closes it and returns the focus', () => {
    render(<SettingsMenu />);
    fireEvent.click(screen.getByTestId('settings-button'));
    fireEvent.click(screen.getByTestId('setting-language-ar'));
    expect(settingsStore.getState().uiLanguage).toBe('ar');
    expect(screen.getByTestId('settings-button')).toHaveAccessibleName(STRINGS.ar.settings.button);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('settings-panel')).toBeNull();
    expect(screen.getByTestId('settings-button')).toHaveFocus();
  });

  it('persists the choices (they are read back by a new store from the same storage)', async () => {
    const { createSettingsStore } = await import('../../src/state/settingsStore');
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    };
    const first = createSettingsStore({ storage, matchMedia: null, language: 'en' });
    first.getState().setSound(true);
    first.getState().setReducedMotion('reduce');
    first.getState().setUiLanguage('ar');
    const second = createSettingsStore({ storage, matchMedia: null, language: 'en' });
    expect(second.getState()).toMatchObject({ sound: true, reducedMotion: 'reduce', uiLanguage: 'ar' });
  });
});
