import { useStrings } from '../../i18n/useStrings';
import { flavourOf } from '../../api/errorDetail';
import { WarningsNote } from '../progress/WarningsNote';
import { useDocumentStore } from '../../state/documentStore';
import { useExperienceStore } from '../../state/experience';
import { useReaderStore } from '../../state/readerStore';

/**
 * The notes over the stage while a manuscript is bound (the pages cannot be drawn; warnings). The page arrows and the
 * paging keys are gone with the PDF browsing (owner direction T.3d); the components stay in the tree, unmounted.
 */
export function ReaderUi() {
  const { t } = useStrings();
  const phase = useExperienceStore((state) => state.phase);
  const hasDocument = useReaderStore((state) => state.hasDocument);
  const pdfError = useDocumentStore((state) => state.pdfError);
  const reading = hasDocument && (phase === 'manuscript' || phase === 'memory');
  return (
    <>
      {reading && pdfError && (
        <p className="reader-note" role="status">
          {flavourOf(pdfError) === 'archiveFull' ? t.reader.pagesArchiveFull : t.reader.pagesNotShown}{' '}
          <span className="technical">{pdfError.message}</span>
        </p>
      )}
      <WarningsNote />
    </>
  );
}
