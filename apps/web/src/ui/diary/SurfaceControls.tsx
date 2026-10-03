import { useStrings } from '../../i18n/useStrings';
import { diaryBookStore } from '../../state/diaryBook';

/**
 * The controls on the margin of the page: a way to step back from it (also Escape and a tap beside the page), and, once the
 * diary has more than one page, to turn to the earlier and the later ones. The earlier page is toward the binding, the later
 * toward the fore-edge, so the arrows point the way a page of that book turns.
 */
export function SurfaceControls({ pages, page, book }: { pages: number; page: number; book: 'ltr' | 'rtl' }) {
  const ctx = useStrings();
  const { t } = ctx;
  // The page the surface lies on is the unturned side: the binding is toward the middle of the book, the fore-edge outward.
  return (
    <div className="pg-controls" data-book={book}>
      <button
        type="button"
        className="pg-leave"
        aria-label={t.diary.leave}
        onClick={() => {
          diaryBookStore.getState().stopWriting();
        }}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
          <path
            d="M6 6 L18 18 M18 6 L6 18"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>
      {pages > 1 && (
        <>
          <button
            type="button"
            className="pg-turn pg-turn--earlier"
            aria-label={t.diary.earlierPage}
            disabled={page <= 0}
            onClick={() => {
              diaryBookStore.getState().turnTo(page - 1);
            }}
          >
            <span aria-hidden="true">{book === 'ltr' ? '‹' : '›'}</span>
          </button>
          <button
            type="button"
            className="pg-turn pg-turn--later"
            aria-label={t.diary.laterPage}
            disabled={page >= pages - 1}
            onClick={() => {
              diaryBookStore.getState().turnTo(page + 1);
            }}
          >
            <span aria-hidden="true">{book === 'ltr' ? '›' : '‹'}</span>
          </button>
          <p className="pg-folio" role="status">
            {ctx.format(t.diary.pageNumber, {
              n: ctx.formatNumber(page + 1),
              total: ctx.formatNumber(pages),
            })}
          </p>
        </>
      )}
    </div>
  );
}
