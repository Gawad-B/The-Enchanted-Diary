import { Component, type ErrorInfo, type ReactNode } from 'react';
import { createStringsContext } from '../i18n/useStrings';
import { settingsStore } from '../state/settingsStore';

interface SpellFailedProps {
  error: Error;
  onBeginAgain: () => void;
}

/**
 * The in-world failure screen: "The spell failed.", the technical message in a smaller ordinary font, and a
 * way out. It reads the language straight from the settings store instead of using hooks, so it still works
 * when the failure came from React or from the stores themselves.
 */
function SpellFailed({ error, onBeginAgain }: SpellFailedProps) {
  const { t, language, direction } = createStringsContext(settingsStore.getState().uiLanguage);
  return (
    <main className="spell-failed" role="alert" lang={language} dir={direction}>
      <h1 className="spell-failed__title">{t.spell.failed}</h1>
      {language !== 'ar' && (
        <p className="spell-failed__detail technical" aria-label={t.spell.technicalLabel}>
          {error.message}
        </p>
      )}
      <button type="button" className="button" onClick={onBeginAgain}>
        {t.spell.beginAgain}
      </button>
    </main>
  );
}

interface ErrorBoundaryProps {
  children: ReactNode;
  /** What "Begin again" does. Defaults to reloading the page. */
  onBeginAgain?: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** The last line of defence: any render error anywhere below shows the in-world failure screen. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <SpellFailed
          error={this.state.error}
          onBeginAgain={
            this.props.onBeginAgain ??
            (() => {
              window.location.reload();
            })
          }
        />
      );
    }
    return this.props.children;
  }
}
