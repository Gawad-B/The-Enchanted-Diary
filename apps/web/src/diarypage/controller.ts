import { diaryBookStore, type DiaryBookStore } from '../state/diaryBook';
import { experienceStore, type ExperienceStore, type Phase } from '../state/experience';
import { readerStore, type ReaderStore } from '../state/readerStore';
import { flyleafStore, type FlyleafStore } from '../ui/diary/flyleafStore';
import { setDraft } from '../ui/diary/quillDraft';
import { diaryLayoutStore, startDiaryLayout, type DiaryLayoutStore } from './service';

/*
 * What keeps the diary's pages and the dive in step with the rest of the experience: how many leaves the book has for the
 * diary, and when the dive is over (the manuscript closes, the reveal takes the stage). The 3D book binds the leaves the
 * diary book store asks for; the writing surface reads the page and the dive from it.
 */

/** The phases in which a manuscript is bound into the book: the diary has its own pages in front of it. */
const MANUSCRIPT_OPEN: readonly Phase[] = ['unveiling', 'manuscript', 'revealing', 'memory'];
/** The phases in which the reader may write in the diary: before a manuscript (on the flyleaf) and in it. */
const WRITABLE: readonly Phase[] = ['awaiting', 'manuscript'];
/** The phases in which the diary is shut: nothing is kept of the dive. */
const SHUT: readonly Phase[] = ['discovery', 'opening', 'reading', 'closing'];

export interface DiaryControllerDeps {
  book?: Pick<DiaryBookStore, 'getState' | 'subscribe'>;
  layout?: Pick<DiaryLayoutStore, 'getState' | 'subscribe'>;
  experience?: Pick<ExperienceStore, 'getState' | 'subscribe'>;
  reader?: Pick<ReaderStore, 'getState' | 'subscribe'>;
  flyleaf?: Pick<FlyleafStore, 'getState'>;
}

/**
 * Keeps the leaves and the dive right. The diary binds a leaf for every page that has writing on it (and the page being
 * written on, even while it is blank), but only while a manuscript is bound in the book. The dive ends when the phase leaves the
 * ones the reader may write in, and everything about it is forgotten when the diary shuts.
 */
export function startDiaryController(deps: DiaryControllerDeps = {}): () => void {
  const book = deps.book ?? diaryBookStore;
  const layout = deps.layout ?? diaryLayoutStore;
  const experience = deps.experience ?? experienceStore;
  const reader = deps.reader ?? readerStore;
  const flyleaf = deps.flyleaf ?? flyleafStore;

  let diveDone = false;
  const sync = (): void => {
    const { phase } = experience.getState();
    const { hasDocument } = reader.getState();
    const state = book.getState();
    if (state.writing && !WRITABLE.includes(phase)) state.stopWriting();
    if (SHUT.includes(phase)) {
      if (state.leaves !== 0 || state.returnTo !== null || state.page !== 0) state.reset();
      setDraft('');
    } else if (phase !== 'manuscript') {
      // The ribbon belongs to the manuscript: the reveal and the memory have the stage to themselves.
      state.clearReturnTo();
    }
    if (phase === 'discovery' || phase === 'manuscript') flyleaf.getState().reset();
    // After the upload the visitor simply starts writing: the camera dives onto the open page once, as the manuscript arrives.
    if (phase === 'manuscript' && hasDocument && !diveDone) {
      diveDone = true;
      if (!book.getState().writing) book.getState().startWriting();
    } else if (phase !== 'manuscript' && phase !== 'revealing' && phase !== 'memory') diveDone = false;
    const { exchanges, layout: pages } = layout.getState();
    const bound = hasDocument && MANUSCRIPT_OPEN.includes(phase);
    const wanted = bound ? (exchanges.length > 0 ? pages.pageCount : 1) : 0;
    if (book.getState().leaves !== wanted) book.getState().setLeaves(wanted);
  };

  sync();
  const stops = [
    experience.subscribe((state, previous) => {
      if (state.phase !== previous.phase || state.documentId !== previous.documentId) sync();
    }),
    reader.subscribe((state, previous) => {
      if (state.hasDocument !== previous.hasDocument) sync();
    }),
    layout.subscribe(sync),
    book.subscribe((state, previous) => {
      if (state.writing !== previous.writing) sync();
    }),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}

/** Starts everything the diary's pages need: the layout (kept current) and the controller. Returns the way to stop. */
export function startDiaryPages(): () => void {
  const stopLayout = startDiaryLayout();
  const stopController = startDiaryController();
  return () => {
    stopController();
    stopLayout();
  };
}
