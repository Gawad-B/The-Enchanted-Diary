import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../../src/components/ErrorBoundary';
import { settingsStore } from '../../src/state/settingsStore';
import { resetStores } from './helpers';

function Throwing(): never {
  throw new Error('render failed: undefined is not a function');
}

let consoleError: { mockRestore(): void };

beforeEach(() => {
  resetStores();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('ErrorBoundary', () => {
  it('renders its children when nothing fails', () => {
    render(
      <ErrorBoundary>
        <p>all well</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('all well')).toBeInTheDocument();
  });

  it('shows "The spell failed.", the technical message and a way out, and logs the error', () => {
    render(
      <ErrorBoundary>
        <Throwing />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'The spell failed.' })).toBeInTheDocument();
    expect(screen.getByText('render failed: undefined is not a function')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Begin again' })).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith('[ErrorBoundary]', expect.any(Error), expect.any(String));
  });

  it('"Begin again" runs the reset action (reloading the page by default)', () => {
    const onBeginAgain = vi.fn();
    render(
      <ErrorBoundary onBeginAgain={onBeginAgain}>
        <Throwing />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Begin again' }));
    expect(onBeginAgain).toHaveBeenCalledTimes(1);
  });

  it('reloads the page by default', () => {
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { reload } });
    try {
      render(
        <ErrorBoundary>
          <Throwing />
        </ErrorBoundary>,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Begin again' }));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it('speaks Arabic, right to left, when the interface is Arabic', () => {
    settingsStore.getState().setUiLanguage('ar');
    render(
      <ErrorBoundary>
        <Throwing />
      </ErrorBoundary>,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('dir', 'rtl');
    expect(alert).toHaveAttribute('lang', 'ar');
    expect(screen.getByRole('heading', { name: 'تعثّرت التعويذة.' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ابدأ من جديد' })).toBeInTheDocument();
  });
});
