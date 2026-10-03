import { useEffect, useMemo, useRef, useState } from 'react';
import { exchangesOf } from '../../diarypage/exchanges';
import { createStringsContext, useStrings } from '../../i18n/useStrings';
import { chatStore, useChatStore } from '../../state/chatStore';
import { confirmStore } from '../../state/confirmStore';
import { experienceStore, useExperienceStore } from '../../state/experience';
import type { Chip } from '../diary/citations';
import { AskField } from './AskField';
import { ExchangeCard } from './ExchangeCard';
import { TruthDialog } from './TruthDialog';
import { usePresenterDone } from './usePresenterDone';

/** Moves the focus to the primary control of a new phase, unless the reader already has it somewhere (or the page just loaded). */
function useFocusOnPhase(target: React.RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const current = document.activeElement;
    if (current === null || current === document.body || current.tagName === 'MAIN') {
      target.current?.focus({ preventScroll: true });
    }
  }, [active, target]);
}

function Welcome({ grab }: { grab: boolean }) {
  const { t, language, direction } = useStrings();
  const sessionChecked = useExperienceStore((state) => state.sessionChecked);
  const start = useRef<HTMLButtonElement>(null);
  // Only a welcome that comes back (after the diary was closed) takes the focus; the first one waits for the reader.
  const [takesFocus] = useState(grab);
  useFocusOnPhase(start, takesFocus && sessionChecked);
  return (
    <section className="simple-welcome" data-testid="simple-welcome" lang={language} dir={direction}>
      {/* The page's heading is the hidden h1 of the stage; this is the same title, written large. */}
      <p className="simple-welcome__title" aria-hidden="true">
        {t.app.title}
      </p>
      <button
        type="button"
        ref={start}
        className="button simple-welcome__start"
        disabled={!sessionChecked}
        onClick={() => {
          experienceStore.getState().dispatch({ type: 'INTERACT' });
        }}
      >
        {t.welcome.start}
      </button>
    </section>
  );
}

/** What the diary says while it has not begun to write, in the language of the question. */
function waitingLine(status: string, language: 'en' | 'ar'): string {
  const { t } = createStringsContext(language);
  if (status === 'rewriting' || status === 'retrieving' || status === 'generating') return t.ask[status];
  return t.ask.answering;
}

function Conversation() {
  const { t, language, direction } = useStrings();
  const messages = useChatStore((state) => state.messages);
  const turn = useChatStore((state) => state.turn);
  const askStatus = useChatStore((state) => state.askStatus);
  const exchanges = useMemo(() => exchangesOf({ messages, turn }, language), [messages, turn, language]);
  const field = useRef<HTMLTextAreaElement>(null);
  const last = useRef<HTMLElement>(null);
  const [truth, setTruth] = useState<{ chip: Chip; language: 'en' | 'ar'; opener: HTMLElement } | null>(null);
  const [clearing, setClearing] = useState(false);
  const safe = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (clearing) safe.current?.focus();
  }, [clearing]);
  useFocusOnPhase(field, true);

  // The newest card scrolls into view when a question is asked (not on every token: a reader may be reading above).
  const count = exchanges.length;
  useEffect(() => {
    // jsdom (the tests) has no scrollIntoView.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    last.current?.scrollIntoView?.({ block: 'nearest' });
  }, [count]);

  const closeTruth = (): void => {
    const opener = truth?.opener;
    setTruth(null);
    // The link may have gone with a conversation that was cleared meanwhile; the field is the next best place.
    if (opener?.isConnected === true) opener.focus();
    else field.current?.focus();
  };

  const settled = (current: boolean): boolean =>
    !current || turn?.status === 'done' || turn?.status === 'failed';

  return (
    <section className="simple-diary" data-testid="simple-diary" lang={language} dir={direction}>
      {/* One polite log of the conversation: a question when it is written, an answer when it is complete (not word by word). */}
      <div
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label={t.diary.log}
        className="visually-hidden"
      >
        {exchanges.flatMap((exchange) => [
          <p key={`${exchange.id}-q`} lang={exchange.language}>
            {t.diary.youWrote.replace('{text}', exchange.question)}
          </p>,
          ...(settled(exchange.current) && exchange.plain !== '' && !exchange.failed
            ? [
                <p key={`${exchange.id}-a`} lang={exchange.language}>
                  {t.diary.diaryWrote.replace('{text}', exchange.plain)}
                </p>,
              ]
            : []),
        ])}
      </div>
      <div className="simple-diary__cards" tabIndex={-1}>
        {exchanges.map((exchange, index) => (
          <ExchangeCard
            key={exchange.id}
            ref={index === exchanges.length - 1 ? last : undefined}
            exchange={exchange}
            turn={exchange.current ? turn : null}
            waiting={waitingLine(askStatus, exchange.language)}
            onTruth={(chip, opener) => {
              setTruth({ chip, language: exchange.language, opener });
            }}
          />
        ))}
      </div>
      <AskField inputRef={field} />
      <div className="simple-diary__tools" role="group" aria-label={t.reader.menu}>
        <button
          type="button"
          className="simple-diary__tool"
          onClick={() => {
            confirmStore.getState().ask({ kind: 'offerAnother' });
          }}
        >
          {t.invitation.offerAnother}
        </button>
        <button
          type="button"
          className="simple-diary__tool"
          onClick={() => {
            confirmStore.getState().ask({ kind: 'close' });
          }}
        >
          {t.invitation.closeDiary}
        </button>
        {exchanges.length > 0 &&
          (clearing ? (
            <span role="group" aria-label={t.diary.clearAsk} className="simple-diary__clear">
              <button
                type="button"
                ref={safe}
                className="simple-diary__tool"
                onClick={() => {
                  setClearing(false);
                }}
              >
                {t.confirm.cancel}
              </button>
              <button
                type="button"
                className="simple-diary__tool simple-diary__tool--danger"
                onClick={() => {
                  setClearing(false);
                  chatStore.getState().requestClear();
                }}
              >
                {t.diary.clearConfirm}
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="simple-diary__tool"
              onClick={() => {
                setClearing(true);
              }}
            >
              {t.diary.clear}
            </button>
          ))}
      </div>
      {truth && <TruthDialog chip={truth.chip} language={truth.language} onClose={closeTruth} />}
    </section>
  );
}

/**
 * The simple view (global section T.3): the new default experience in plain DOM, for browsers without WebGL and for the session
 * after the 3D scene has failed. A welcome title with one button; then the same upload (the stage's own upload portal and
 * progress, drawn here as parchment cards); then the conversation, one parchment card per exchange, each with its own "Show me
 * the truth". The manuscript's pages cannot be browsed. It ends every transitional phase at once (presenter contract).
 */
export function SimpleView() {
  usePresenterDone();
  const phase = useExperienceStore((state) => state.phase);
  const talking = phase === 'manuscript' || phase === 'memory' || phase === 'revealing';
  const welcome = phase === 'discovery';
  // The very first welcome waits for the reader; one that comes back (the diary was closed: the epoch has moved on) takes the focus.
  const returning = useExperienceStore((state) => state.epoch > 0);
  return (
    <div className="simple-view" data-testid="simple-view" data-phase={phase}>
      {welcome && <Welcome grab={returning} />}
      {talking && <Conversation />}
    </div>
  );
}
