import { directionForLanguage } from '@enchanted/shared';
import { startPdfBook } from '../pdf/pdfBook';
import { startEffects } from './effects';
import { startSessionEffect } from './effects/session';
import { startNarrowSync } from './narrowSync';
import { startReaderSync } from './readerSync';
import { settingsStore, type SettingsStore } from './settingsStore';
import { startWatchdogs } from './watchdogs';

/**
 * Keeps <html lang>, <html dir> and <html data-reduced-motion> in step with the settings: the interface
 * language sets the page language and direction (a document's own direction is applied per element, never to
 * the whole page), and the resolved reduced-motion value drives the CSS in global.css.
 */
export function syncDocumentSettings(
  settings: Pick<SettingsStore, 'getState' | 'subscribe'> = settingsStore,
  root: HTMLElement = document.documentElement,
): () => void {
  const apply = (): void => {
    const { uiLanguage, reducedMotionResolved } = settings.getState();
    root.lang = uiLanguage;
    root.dir = directionForLanguage(uiLanguage);
    root.dataset.reducedMotion = String(reducedMotionResolved);
  };
  apply();
  return settings.subscribe(apply);
}

/** Starts everything that runs outside React for the life of the page. Returns the function that stops it. */
export function startApplication(): () => void {
  const stops = [
    syncDocumentSettings(),
    startWatchdogs(),
    // The effects subscribe before the session check can dispatch (a restored processing document goes straight to `reading`).
    startEffects(),
    startPdfBook(),
    startSessionEffect(),
    startReaderSync(),
    startNarrowSync(),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}
