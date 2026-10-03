import { useStrings } from '../../i18n/useStrings';
import { diaryLayoutStore } from '../../diarypage/service';
import { diaryBookStore, useDiaryBook } from '../../state/diaryBook';

/** Dives onto the diary's page: the one the next question goes on (the last one). */
export function startWriting(): void {
  diaryBookStore.getState().startWriting(diaryLayoutStore.getState().layout.next.page);
}

/** The quill: the glyph of the button that opens the diary's page. */
export function QuillGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        d="M20 3 C13 4 8 9 6 15 L5 20 L9 19 C15 17 19 12 20 3 Z M6 15 L12 11"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * The quill button of the reader's bar: "Write in the diary". It dives the camera onto the diary's page and, pressed again,
 * steps back from it (it says which with `aria-pressed`).
 */
export function WriteToggle({ className }: { className?: string }) {
  const { t } = useStrings();
  const writing = useDiaryBook((state) => state.writing);
  return (
    <button
      type="button"
      className={className}
      aria-pressed={writing}
      data-testid="write-toggle"
      onClick={() => {
        if (writing) diaryBookStore.getState().stopWriting();
        else startWriting();
      }}
    >
      <QuillGlyph />
      {t.diary.writeInDiary}
    </button>
  );
}
