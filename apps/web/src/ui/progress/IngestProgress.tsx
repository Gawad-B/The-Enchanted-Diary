import { useEffect, useRef, useState } from 'react';
import { useStrings } from '../../i18n/useStrings';
import { useDocumentStore } from '../../state/documentStore';
import { experienceStore, useExperienceStore } from '../../state/experience';
import { pageEffectsStore } from '../../state/pageEffectsStore';
import { aboveBook, flyleafZone, useAnchoredBox } from '../upload/anchoring';
import { announcementKey, fractionOf, stageLine, uploadLine } from './progressText';

/** The glow along the book's edges while it reads: a faint baseline, and the real fraction of the stage on top of it. */
const GLOW_BASELINE = 0.25;
const GLOW_RANGE = 0.75;

/** A clock that ticks once a second while `active` (the countdown of a pause that has a real end). */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [active]);
  return now;
}

function clockTime(at: number, language: string): string {
  return new Intl.DateTimeFormat(language === 'ar' ? 'ar-u-nu-arab' : 'en', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(at);
}

/**
 * The in-world progress while a manuscript is offered and read: a line with the REAL numbers of the step the server (or the
 * upload) is at, a quiet technical note, and a control to withdraw the manuscript. A polite live region carries the same
 * text to a screen reader, but changes only when the stage does or a quarter of it is done. The edges of the book glow
 * with the real fraction of the stage that is finished (`pageEffectsStore` source "progress"): no estimate, no fake timer.
 *
 * It sits on the flyleaf's lower band while the book is open and uploading, and above the closed book while it reads.
 */
export function IngestProgress() {
  const ctx = useStrings();
  const { t, language } = ctx;
  const phase = useExperienceStore((state) => state.phase);
  const upload = useDocumentStore((state) => state.uploadProgress);
  const ingest = useDocumentStore((state) => state.ingestProgress);
  const pause = useDocumentStore((state) => state.ingestPause);
  const uploading = phase === 'uploading';
  const visible = uploading || phase === 'reading';
  const withdraw = useRef<HTMLButtonElement>(null);
  const box = useAnchoredBox<HTMLDivElement>(uploading ? flyleafZone : aboveBook, visible);
  const now = useNow(pause?.kind === 'waiting');

  // "Choose a manuscript" has just gone from under the reader's hand (an offer began): the control that is left is the one to
  // reach. Only then, and only when the focus has nowhere to be (it would be lost to the page otherwise): never taken from
  // where the reader put it, and never on a page load that resumes a reading (a stray Space would withdraw the manuscript).
  useEffect(() => {
    if (!uploading) return;
    const active = document.activeElement;
    if (active === null || active === document.body) withdraw.current?.focus({ preventScroll: true });
  }, [uploading]);

  let line: string;
  let fraction: number | null;
  let key: string;
  if (uploading) {
    line = upload ? uploadLine(upload, ctx) : t.progress.upload;
    fraction = fractionOf(upload ? { completed: upload.loaded, total: upload.total } : null);
    key = announcementKey('upload', fraction === null ? null : fraction >= 1 ? 1 : 0);
  } else if (ingest) {
    line = stageLine(ingest, ctx);
    fraction = fractionOf(ingest);
    key = announcementKey(ingest.stage, fraction);
  } else {
    line = t.ingestStage.queued;
    fraction = null;
    key = 'queued';
  }

  // The glow follows the real fraction of the current stage.
  useEffect(() => {
    if (!visible) return undefined;
    pageEffectsStore.getState().set('progress', { edgeGlow: GLOW_BASELINE + GLOW_RANGE * (fraction ?? 0) });
    return () => {
      pageEffectsStore.getState().clear('progress');
    };
  }, [visible, fraction]);

  // What a screen reader hears: updated when the stage changes or a quarter more is done.
  const [announced, setAnnounced] = useState(line);
  const lastKey = useRef(key);
  useEffect(() => {
    if (lastKey.current !== key) {
      lastKey.current = key;
      setAnnounced(line);
    }
  }, [key, line]);

  if (!visible) return null;
  const seconds = pause?.kind === 'waiting' ? Math.max(0, Math.ceil((pause.retryAt - now) / 1000)) : 0;
  const parked = pause?.kind === 'parked' ? pause : null;
  return (
    <div
      className="ingest-progress"
      ref={box}
      data-testid="ingest-progress"
      data-placed="false"
      data-surface={uploading ? 'flyleaf' : 'stage'}
    >
      <p className="visually-hidden" role="status" aria-live="polite" aria-label={t.upload.progressLabel}>
        {parked ? t.progress.parked : announced}
      </p>
      {/* What is said can be longer than the band it has: it scrolls there while the button stays put. */}
      <div className="ingest-progress__messages">
        <p className="ingest-progress__line" aria-hidden="true">
          {line}
        </p>
        {parked && (
          <>
            <p className="ingest-progress__note">{t.progress.parked}</p>
            <p className="ingest-progress__note">
              {ctx.format(t.progress.parkedResume, { time: clockTime(parked.retryAt, language) })}
            </p>
            {parked.detail && language !== 'ar' && (
              <p className="technical ingest-progress__technical">{parked.detail}</p>
            )}
          </>
        )}
        {pause?.kind === 'waiting' && (
          <p className="ingest-progress__note">
            {t.progress.waiting}{' '}
            {seconds > 0 && ctx.format(t.progress.waitingSeconds, { n: ctx.formatNumber(seconds) })}
          </p>
        )}
      </div>
      <button
        ref={withdraw}
        type="button"
        className="button ingest-progress__withdraw"
        onClick={() => {
          experienceStore.getState().dispatch({ type: 'CANCEL' });
        }}
      >
        {t.upload.withdraw}
      </button>
    </div>
  );
}
