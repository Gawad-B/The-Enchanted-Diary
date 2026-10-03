import { useEffect, useState } from 'react';
import { navigationForKey } from '../../book/bookLayout';
import { useStrings } from '../../i18n/useStrings';
import { anchorStore } from '../../state/anchorStore';
import { useExperienceStore } from '../../state/experience';
import { diaryBookStore, useDiaryBook } from '../../state/diaryBook';
import { useSettingsStore } from '../../state/settingsStore';
import { FlyleafSurface } from './FlyleafSurface';
import { WritingSurface } from './WritingSurface';

/** Whether a key press belongs to something the reader is typing into or operating (not to the book). */
function belongsToControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return true;
  return (
    target.closest(
      '[role="textbox"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
    ) !== null
  );
}

/** How long the surface stays up after the reader steps back from the page: its fade, then it is taken down. */
const FADE_MS = 240;

/** Keeps a surface mounted for a moment after it is no longer wanted, so that it can fade. */
function useLingering(wanted: boolean, reduced: boolean): boolean {
  const [mounted, setMounted] = useState(wanted);
  // Wanted again (or for the first time): it is mounted from this render on.
  if (wanted && !mounted) setMounted(true);
  useEffect(() => {
    if (wanted) return undefined;
    const timer = setTimeout(
      () => {
        setMounted(false);
      },
      reduced ? 0 : FADE_MS,
    );
    return () => {
      clearTimeout(timer);
    };
  }, [wanted, reduced]);
  return wanted || mounted;
}

/**
 * Writing in the diary (global section T), hosted over the stage. The surface is the diary's own page, laid onto the 3D leaf;
 * this decides which page it is (the flyleaf before there is a manuscript, a diary page after), keeps Escape and a tap beside
 * the page as ways back, offers the quill on the flyleaf and, after a citation took the reader to the manuscript, the ribbon
 * that brings them back to the page they were writing on.
 */
export function DiaryWriting() {
  const phase = useExperienceStore((state) => state.phase);
  const writing = useDiaryBook((state) => state.writing);
  const returnTo = useDiaryBook((state) => state.returnTo);
  const reduced = useSettingsStore((state) => state.reducedMotionResolved);
  const mounted = useLingering(writing && (phase === 'awaiting' || phase === 'manuscript'), reduced);

  useEffect(() => {
    if (!writing) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      diaryBookStore.getState().stopWriting();
    };
    // The page turns are the diary's while the reader writes: the manuscript's pages stay where they are (this sees the key
    // first, in the capture phase, and keeps it from the reader's own keyboard input).
    const onTurn = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (belongsToControl(event.target)) return;
      const action = navigationForKey(event.key, anchorStore.getState().layoutDirection);
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      const book = diaryBookStore.getState();
      const target =
        action === 'first'
          ? 0
          : action === 'last'
            ? book.leaves - 1
            : book.page + (action === 'next' ? 1 : -1);
      book.turnTo(target);
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onTurn, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onTurn, true);
    };
  }, [writing]);

  return (
    <>
      {writing && <Backdrop />}
      {mounted && (phase === 'awaiting' ? <FlyleafSurface /> : <WritingSurface />)}
      {phase === 'manuscript' && !writing && returnTo !== null && <Ribbon page={returnTo} />}
    </>
  );
}

/** A tap beside the page steps back from it (the page's own button and Escape are the keyboard's ways). Not a tab stop. */
function Backdrop() {
  return (
    <div
      className="diary-backdrop"
      aria-hidden="true"
      data-testid="diary-backdrop"
      onPointerDown={() => {
        diaryBookStore.getState().stopWriting();
      }}
    />
  );
}

/** The ribbon bookmark: a citation took the reader to the manuscript; it brings them back to the page they were writing on. */
function Ribbon({ page }: { page: number }) {
  const { t } = useStrings();
  return (
    <div className="diary-ribbon">
      <button
        type="button"
        className="diary-ribbon__button"
        data-testid="diary-ribbon"
        onClick={() => {
          diaryBookStore.getState().startWriting(page);
        }}
      >
        <span className="diary-ribbon__label">{t.diary.returnToDiary}</span>
      </button>
    </div>
  );
}
