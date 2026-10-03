import { useStrings } from '../../i18n/useStrings';
import { useExperienceStore } from '../../state/experience';
import { useDiaryBook } from '../../state/diaryBook';
import { WriteToggle } from '../diary/WriteToggle';
import { useReaderStore } from '../../state/readerStore';
import { DiaryMenu } from './DiaryMenu';

/**
 * The bar in the stage's footer under the book: the quill (Task 7) and the diary menu. There is NO page browsing in the
 * default experience (owner direction T.3d): no page indicator, no "Go to page", no "Read closely", no page arrows. The PDF's
 * pages are reached only through the diary's own "show me the truth".
 */
export function ReaderBar() {
  const phase = useExperienceStore((state) => state.phase);
  const hasDocument = useReaderStore((state) => state.hasDocument);
  // The bar is its own component while it is there: whatever it had open is gone with it when the manuscript closes.
  return hasDocument && (phase === 'manuscript' || phase === 'memory') ? <ReaderBarBody /> : null;
}

function ReaderBarBody() {
  const { direction: interfaceDirection } = useStrings();
  const phase = useExperienceStore((state) => state.phase);
  const direction = useReaderStore((state) => state.direction);
  const writing = useDiaryBook((state) => state.writing);
  return (
    <div
      className="reader-bar"
      dir={interfaceDirection}
      data-side={direction === 'rtl' ? 'right' : 'left'}
      data-testid="reader-bar"
    >
      <div className="reader-bar__tools">
        {/* Task 7: the quill that dives onto the diary's page (the camera reads the diary book store). */}
        {phase === 'manuscript' && !writing && <WriteToggle className="reader-bar__button write-toggle" />}
        <DiaryMenu />
      </div>
    </div>
  );
}
