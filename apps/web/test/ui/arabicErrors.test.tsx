import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ErrorBoundary } from '../../src/components/ErrorBoundary';
import { FallbackMount } from '../../src/components/FallbackMount';
import { ForcedSimpleNotice } from '../../src/components/ForcedSimpleNotice';
import { settingsStore } from '../../src/state/settingsStore';
import { newTurn } from '../../src/state/chatTurn';
import { AskFailure } from '../../src/ui/diary/AskFailure';
import { InWorldError } from '../../src/ui/upload/InWorldError';
import { resetStores } from '../components/helpers';

/* "Arabic means Arabic": no English technical text (codes, server messages, WebGL reasons) in the Arabic interface. */

const LATIN = /[A-Za-z]{2,}/u;
const error = {
  code: 'EMBEDDING_FAILED',
  message: 'The search model is busy right now',
  detail: 'try again',
} as const;

function Bomb(): never {
  throw new Error('Cannot read properties of undefined');
}

describe('Arabic error states carry no Latin text', () => {
  beforeEach(() => {
    resetStores();
    settingsStore.setState({ uiLanguage: 'ar' });
  });
  afterEach(() => {
    settingsStore.setState({ uiLanguage: 'en' });
  });

  it('InWorldError', () => {
    const { container } = render(<InWorldError error={error} />);
    expect(container.textContent).not.toBe('');
    expect(container.textContent).not.toMatch(LATIN);
  });

  it('AskFailure, in the language of the question', () => {
    const turn = { ...newTurn('t', 'ما هذا؟', 0), status: 'failed' as const, error };
    const { container } = render(<AskFailure turn={turn} language="ar" />);
    expect(container.textContent).not.toMatch(LATIN);
  });

  it('the fallback notices leave the English WebGL reason out', () => {
    const { container } = render(
      <FallbackMount webglReason="The browser could not create a WebGL context" />,
    );
    expect(container.querySelector('.fallback-mount__note')?.textContent).not.toMatch(LATIN);
    settingsStore.setState({ forcedSimple: { reason: 'The WebGL context was lost' } } as never);
    const forced = render(<ForcedSimpleNotice />);
    expect(forced.container.textContent).not.toMatch(LATIN);
  });

  it('the error boundary screen', () => {
    const quiet = console.error;
    console.error = () => undefined;
    const { container } = render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    console.error = quiet;
    expect(container.textContent).not.toMatch(LATIN);
  });
});
