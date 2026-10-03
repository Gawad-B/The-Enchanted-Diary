import { useEffect, useMemo, useRef } from 'react';
import { STRINGS } from '../../i18n/strings';
import { useStrings } from '../../i18n/useStrings';
import { useRevealStore, revealStore } from '../../reveal/revealStore';
import { useExperienceStore } from '../../state/experience';
import { useSettingsStore } from '../../state/settingsStore';
import { skipTruthScene, returnToMyPage } from './showTruth';
import { pageNumberFormat } from '../reader/numerals';

/**
 * The "Show me the truth" scene as the visitor meets it, over whichever presenter is active: the diary's line written in ink,
 * a Skip control, and then the cited page with its passage glowing, a handwritten arrow to the next cited page (when there are
 * several) and the ribbon "Return to my page". The book, the camera and the passage's glow are the conductor's
 * (state/effects/reveal.ts); this only shows the beat it is told.
 */
export function TruthScene() {
  const phase = useExperienceStore((state) => state.phase);
  const active = useRevealStore((state) => state.pages.length > 0);
  if (!active) return null;
  const memory = phase === 'memory';
  return (
    <div className="truth" data-testid="truth-scene" data-phase={phase}>
      {!memory && <Scrim />}
      <TruthLine />
      <TruthPage />
      {!memory && <SkipButton />}
    </div>
  );
}

/** Escape or a tap anywhere skips the scene (a tap is on the scrim, which sits behind the controls). */
function Scrim() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      skipTruthScene();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);
  return (
    <div
      className="truth__scrim"
      aria-hidden="true"
      onPointerDown={() => {
        skipTruthScene();
      }}
    />
  );
}

function SkipButton() {
  const { t } = useStrings();
  return (
    <button
      type="button"
      className="truth__skip"
      data-testid="truth-skip"
      onClick={() => {
        skipTruthScene();
      }}
    >
      {t.truth.skip}
    </button>
  );
}

/** The diary's line, written as the beat runs: a glyph at a time, a word at a time in Arabic (never letter by letter). */
function TruthLine() {
  const language = useRevealStore((state) => state.language);
  const beat = useRevealStore((state) => state.beat);
  const progress = useRevealStore((state) => (state.beat === 'line' ? state.t : 1));
  const reduced = useSettingsStore((state) => state.reducedMotionResolved);
  const text = STRINGS[language].diary.showTruthLine;
  const units = useMemo(
    () => (language === 'ar' ? text.split(/(\s+)/u) : Array.from(text)),
    [language, text],
  );
  if (beat === null) return null;
  const shown = reduced ? units.length : Math.ceil(progress * units.length);
  return (
    <p
      className="truth__line"
      data-testid="truth-line"
      data-fading={beat !== 'line' || undefined}
      lang={language}
      dir={language === 'ar' ? 'rtl' : 'ltr'}
      aria-label={text}
    >
      <span aria-hidden="true">{units.slice(0, shown).join('')}</span>
      <span aria-hidden="true" className="truth__line-rest">
        {units.slice(shown).join('')}
      </span>
    </p>
  );
}

/** The cited page, once its beat comes (a crossfade) and while the memory lasts. */
function TruthPage() {
  const { t, format, language, direction } = useStrings();
  const phase = useExperienceStore((state) => state.phase);
  const beat = useRevealStore((state) => state.beat);
  const opacity = useRevealStore((state) => (state.beat === 'page' ? state.t : 0));
  const pages = useRevealStore((state) => state.pages);
  const index = useRevealStore((state) => state.index);
  const image = useRevealStore((state) => state.image);
  const failed = useRevealStore((state) => state.imageFailed);
  const holder = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const memory = phase === 'memory';
  const visible = memory || beat === 'page';
  const target = pages[index];
  const picture = image?.page === target?.page ? (image?.canvas ?? null) : null;

  useEffect(() => {
    const node = holder.current;
    if (!node) return;
    if (picture) {
      picture.classList.add('truth__canvas');
      node.replaceChildren(picture);
    } else {
      node.replaceChildren();
    }
  }, [picture, visible]);

  // The memory has come: the way back takes the focus (the ribbon is the first thing to reach).
  useEffect(() => {
    if (memory) back.current?.focus({ preventScroll: true });
  }, [memory]);

  useEffect(() => {
    if (!memory) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      returnToMyPage();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, [memory]);

  if (!visible || !target) return null;
  const number = pageNumberFormat(language)(target.page);
  const goTo = (next: number): void => {
    revealStore.getState().setIndex(next);
  };
  const forward = direction === 'rtl' ? '←' : '→';
  const backward = direction === 'rtl' ? '→' : '←';
  return (
    <section
      className="truth__page"
      role="dialog"
      aria-label={t.truth.dialogLabel}
      data-testid="truth-page"
      style={{ opacity: memory ? 1 : opacity }}
    >
      <div className="truth__sheet" data-ready={picture ? 'true' : 'false'}>
        <div className="truth__canvas-holder" ref={holder} />
        {failed && <p className="truth__failed">{t.truth.imageFailed}</p>}
      </div>
      <p className="truth__caption" data-testid="truth-caption">
        {format(t.truth.pageLabel, { n: number })}
      </p>
      <div className="truth__controls">
        {pages.length > 1 && (
          <button
            type="button"
            className="truth__hand"
            data-testid="truth-prev"
            disabled={index <= 0}
            onClick={() => {
              goTo(index - 1);
            }}
          >
            <span aria-hidden="true">{backward} </span>
            {t.truth.prevPage}
          </button>
        )}
        <button
          type="button"
          className="truth__ribbon"
          data-testid="truth-return"
          ref={back}
          disabled={!memory}
          onClick={() => {
            returnToMyPage();
          }}
        >
          {t.truth.returnToPage}
        </button>
        {pages.length > 1 && (
          <button
            type="button"
            className="truth__hand"
            data-testid="truth-next"
            disabled={index >= pages.length - 1}
            onClick={() => {
              goTo(index + 1);
            }}
          >
            {t.truth.nextPage}
            <span aria-hidden="true"> {forward}</span>
          </button>
        )}
      </div>
    </section>
  );
}
