import { useEffect, useRef, useState } from 'react';
import type { Language } from '../../i18n/strings';
import { createStringsContext } from '../../i18n/useStrings';
import { pageImageService } from '../../pdf/pageImageService';
import { zeroCanvas } from '../../pdf/pageRenderer';
import { useDocumentStore } from '../../state/documentStore';
import type { Chip } from '../diary/citations';

/** The width the page is drawn at, in device pixels: enough for a phone held in the hand, never more than a desktop shows. */
function pagePixels(): number {
  const ratio = typeof window === 'undefined' ? 1 : Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
  const width = typeof window === 'undefined' ? 800 : Math.min(window.innerWidth, 720);
  return Math.round(width * ratio);
}

const FOCUSABLE = 'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])';

interface TruthDialogProps {
  chip: Chip;
  language: Language;
  onClose: () => void;
}

/**
 * "Show me the truth": the page of the manuscript the answer rests on, as a picture from the shared page image service, with
 * the passage glowing on it (the renderer paints the highlight). Nothing else of the manuscript can be browsed. A modal
 * dialog in the diary's own language: the focus goes in, is kept in, and returns to the link that opened it when it closes.
 */
export function TruthDialog({ chip, language, onClose }: TruthDialogProps) {
  const ctx = createStringsContext(language);
  const { t } = ctx;
  const pdfError = useDocumentStore((state) => state.pdfError);
  const frame = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [drawn, setDrawn] = useState(false);
  const [failed, setFailed] = useState(false);

  const label =
    chip.pageEnd > chip.pageStart
      ? ctx.format(t.citation.pages, {
          from: ctx.formatNumber(chip.pageStart),
          to: ctx.formatNumber(chip.pageEnd),
        })
      : ctx.format(t.citation.page, { n: ctx.formatNumber(chip.pageStart) });

  useEffect(() => {
    close.current?.focus();
  }, []);

  useEffect(() => {
    const host = frame.current;
    if (!host) return undefined;
    setDrawn(false);
    setFailed(false);
    let canvas: HTMLCanvasElement | null = null;
    let disposed = false;
    const job = pageImageService.enqueue({
      page: chip.pageStart,
      width: pagePixels(),
      priority: 0,
      highlight: chip.rects,
    });
    job.promise.then(
      (result) => {
        if (disposed) {
          zeroCanvas(result);
          return;
        }
        canvas = result;
        result.className = 'truth__canvas';
        host.replaceChildren(result);
        setDrawn(true);
      },
      () => {
        if (!disposed) setFailed(true);
      },
    );
    return () => {
      disposed = true;
      job.cancel();
      if (canvas) zeroCanvas(canvas);
    };
  }, [chip]);

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="truth" lang={language} dir={ctx.direction}>
      {/* A dialog handles its own Escape and Tab (the focus is kept inside): the keys belong on the dialog element. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        className="truth__dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t.diary.showTruth}
        ref={dialog}
        onKeyDown={onKeyDown}
      >
        <p className="truth__line">{t.diary.showTruthLine}</p>
        {/* The canvas is put in by hand: the frame has no React children. */}
        <div className="truth__frame" ref={frame} role="img" aria-label={label} data-drawn={drawn} />
        {!drawn && (
          <p className="truth__wait" role="status">
            {failed || pdfError !== null ? t.reader.pagesNotShown : label}
          </p>
        )}
        <p className="truth__page">{label}</p>
        <button type="button" ref={close} className="button truth__close" onClick={onClose}>
          {t.diary.returnToDiary}
        </button>
      </div>
    </div>
  );
}
