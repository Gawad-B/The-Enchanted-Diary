import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { documentStore } from '../../src/state/documentStore';
import { experienceStore, initialExperienceState } from '../../src/state/experience';
import { readerStore } from '../../src/state/readerStore';
import { WarningsNote, pageRanges } from '../../src/ui/progress/WarningsNote';
import { settingsStore } from '../../src/state/settingsStore';
import { makeDocument } from '../fixtures';
import { resetStores } from '../components/helpers';

/*
 * The warnings' pages: a gap the review named (reader m-17).
 */

beforeEach(() => {
  resetStores();
  documentStore.getState().reset();
  readerStore.getState().reset();
});

describe('the warnings name their pages (m-17)', () => {
  it('collapses runs into ranges, in the interface\'s digits, and says "…" after six', () => {
    const plain = (n: number) => String(n);
    expect(pageRanges([3, 4, 5, 9, 12, 13], plain)).toBe('3–5, 9, 12–13');
    expect(pageRanges([9, 3, 3, 4], plain)).toBe('3–4, 9');
    expect(pageRanges([], plain)).toBe('');
    expect(pageRanges([1, 3, 5, 7, 9, 11, 13, 15], plain)).toBe('1, 3, 5, 7, 9, 11…');
  });

  it("the note says which pages, in the interface language's numerals", () => {
    documentStore.getState().setDocument(
      makeDocument({
        warnings: [
          { code: 'OCR_PARTIAL', pages: [3, 4, 5, 9] },
          { code: 'LOW_TEXT_QUALITY', pages: [] },
        ],
      }),
    );
    experienceStore.setState({
      ...initialExperienceState,
      phase: 'manuscript',
      sessionChecked: true,
      documentId: 'x',
    });
    const { unmount } = render(<WarningsNote />);
    expect(screen.getByTestId('warnings-note')).toHaveTextContent(
      'Some pages had faded; I could read only part of them. Ask with care. Pages: 3–5, 9. OCR_PARTIAL',
    );
    expect(screen.getByTestId('warnings-note')).toHaveTextContent(
      /scrambled\. Check my answers against the page\. LOW_TEXT_QUALITY/,
    ); // no pages named: none invented
    unmount();
    act(() => {
      settingsStore.setState({ uiLanguage: 'ar' });
    });
    render(<WarningsNote />);
    expect(screen.getByTestId('warnings-note')).toHaveTextContent('الصفحات: ٣–٥، ٩.');
  });
});
