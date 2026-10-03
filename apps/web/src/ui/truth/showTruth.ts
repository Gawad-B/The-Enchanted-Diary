import { revealStore } from '../../reveal/revealStore';
import { diaryBookStore } from '../../state/diaryBook';
import { beginTruth, dismissTruth, skipTruth } from '../../state/effects/reveal';

// The book shows the PDF pages only while the truth scene has a cited page to show (§T.4.5: otherwise it rests on the diary).
revealStore.subscribe((state) => diaryBookStore.getState().setPdfVisible(state.pages.length > 0));

/**
 * "Show me the truth" under an answer: the entry point of the scene (the diary writes its line, the book riffles, the camera zooms
 * in and out, the cited page appears with the passage glowing). `answerId` is the id of the exchange the link sits under (what
 * the page's notes carry). Returns false when the scene cannot start now (it is already running, or the book is not at rest).
 */
export function showTruth(answerId: string): boolean {
  return beginTruth(answerId);
}

/** Skip: the cited page appears in 200 ms. */
export const skipTruthScene = skipTruth;
/** "Return to my page". */
export const returnToMyPage = dismissTruth;
