import { useMemo, useState } from 'react';
import { useStrings } from '../../i18n/useStrings';
import { useDocumentStore } from '../../state/documentStore';
import { useExperienceStore } from '../../state/experience';
import { pageNumberFormat } from '../reader/numerals';

/** The most ranges a warning names before it says "…" (a 300-page scan can be faded throughout). */
const MAX_RANGES = 6;

/** Page numbers as ranges ("3–5, 9"), at most `MAX_RANGES` of them, in the interface's digits. */
export function pageRanges(
  pages: readonly number[],
  format: (value: number) => string,
  separator = ', ',
): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let i = 0; i < sorted.length;) {
    let end = i;
    while (end + 1 < sorted.length && sorted[end + 1] === (sorted[end] ?? 0) + 1) end += 1;
    const first = sorted[i] ?? 0;
    const last = sorted[end] ?? 0;
    ranges.push(end > i ? `${format(first)}–${format(last)}` : format(first));
    i = end + 1;
  }
  return ranges.length > MAX_RANGES
    ? `${ranges.slice(0, MAX_RANGES).join(separator)}…`
    : ranges.join(separator);
}

/**
 * Warnings the reading raised (OCR only partly possible, scrambled pages), as a gentle note once the manuscript is open,
 * in the diary's voice, with the technical code. The reader can put it away.
 */
export function WarningsNote() {
  const { t, language, format: fill } = useStrings();
  const phase = useExperienceStore((state) => state.phase);
  const document = useDocumentStore((state) => state.document);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const format = useMemo(() => pageNumberFormat(language), [language]);
  if (!document || phase !== 'manuscript' || document.warnings.length === 0 || dismissedFor === document.id)
    return null;
  return (
    <div className="reader-note warnings-note" role="status" data-testid="warnings-note">
      {document.warnings.map((warning) => (
        <p key={warning.code} className="warnings-note__line">
          {t.warnings[warning.code]}
          {warning.pages.length > 0 && (
            <>
              {' '}
              <bdi>
                {fill(t.reader.warningPages, {
                  pages: pageRanges(warning.pages, format, language === 'ar' ? '، ' : ', '),
                })}
              </bdi>
            </>
          )}{' '}
          {language !== 'ar' && <span className="technical">{warning.code}</span>}
        </p>
      ))}
      <button
        type="button"
        className="reader-bar__button"
        onClick={() => {
          setDismissedFor(document.id);
        }}
      >
        <span aria-hidden="true">×</span>
        <span className="visually-hidden">{t.reader.dismiss}</span>
      </button>
    </div>
  );
}
