import type { IngestStage, WarningCode } from '@enchanted/shared';
import type { UiErrorCode } from '../../api/client';
import type { ErrorFlavour } from '../../api/errorDetail';
import type { Phase } from '../../state/experience';

/*
 * All user-facing copy, English and Arabic, keyed by purpose. The voice is a patient, slightly formal, honest
 * old book: short sentences, no film quotes, no character names.
 * Placeholders are written {name}; callers fill them with `format()` and locale-aware numbers.
 *
 * Arabic is Modern Standard Arabic, written naturally rather than word for word, with masculine-generic
 * imperatives. The lines that are not in the research table were written for this file: have a native editor
 * review all Arabic before release.
 *
 * Rules the experience follows with these lines (research section 7 notes):
 *  - An error line is always paired with its technical code/message in a smaller ordinary font, and with a
 *    clear action. The in-world line comes first.
 *  - The pre-upload lines cycle by attempt count.
 */

export type Language = 'en' | 'ar';

export interface Strings {
  app: {
    title: string;
    /** The product is a fan-inspired concept, not an official product. */
    fanDisclaimer: string;
    stageLabel: string;
  };
  /** What a screen reader hears when the experience enters a phase. */
  live: Record<Phase, string>;
  /** The welcome screen: the title and one button. */
  welcome: {
    start: string;
  };
  /** Accessibility infrastructure that is not tied to a place in the story. */
  a11y: {
    /** The skip link, the first control of the page: moves the focus to the diary. */
    skipToMain: string;
  };
  invitation: {
    /** Empty state of the closed book (spec section 52). */
    waiting: string;
    /** Spec section 12. */
    placeDocument: string;
    /** Research line 7. */
    dropZone: string;
    choose: string;
    offerAnother: string;
    closeDiary: string;
    startNewSession: string;
    /** Research line 8: placeholder of the writing field. */
    writePrompt: string;
  };
  /** The upload ritual: the controls on the flyleaf, the drop target and what the diary says about them. */
  upload: {
    /** The quieter second choice on the flyleaf. */
    /** Shown over the book while a file is dragged over the window. */
    dropHint: string;
    /** Cancel control while the manuscript is being offered or read. */
    withdraw: string;
    /** Accessible label of the invisible drop surface. */
    dropSurface: string;
    /** Shown before the first upload when the model service is a free tier that may learn from what it reads. */
    freeTierNotice: string;
    /** Accessible name of the progress region. */
    progressLabel: string;
    /** Accessible name of the scrollable area that holds what the diary says about an offer (an error, a notice). */
    messagesLabel: string;
    /** {name}: the file the reader dropped while the diary was reading another (it follows `hints.stillReading`). */
    stillReadingFile: string;
  };
  progress: {
    /** Research lines 1 to 5. */
    reading: string;
    indexing: string;
    listening: string;
    slow: string;
    longWait: string;
    /** {n}: manuscripts waiting ahead of this one. */
    queuePosition: string;
    upload: string;
    /** How the real counts of a stage are written after its line. */
    counts: {
      /** {completed} of {total} pages */
      pages: string;
      /** OCR works page by page: "page 2 of 3". */
      ocrPages: string;
      /** {completed} of {total} passages */
      chunks: string;
      /** {completed} of {total} steps */
      steps: string;
      /** {loaded} of {total}: sizes already carry their unit. */
      bytes: string;
    };
    /** The daily quota of the model service is used up: the diary rests. */
    parked: string;
    /** {time}: when the quota starts again, in the reader's own clock. */
    parkedResume: string;
    /** The line is full or a limit holds the next step: it comes by itself. */
    waiting: string;
    /** {n}: seconds until the next try. */
    waitingSeconds: string;
  };
  /** Sizes and limits written into the error lines ({limit}). */
  units: {
    megabytes: string;
    kilobytes: string;
    pages: string;
  };
  /** One line per real ingestion stage; the progress UI shows the line of the stage the server reports. */
  ingestStage: Record<IngestStage, string>;
  ask: {
    rewriting: string;
    retrieving: string;
    generating: string;
    answering: string;
    diaryStillWriting: string;
    /** Opens with the spec's unsupported-answer line (section 53), then research line 14. */
    notFound: string;
    /** Research line 15: prefix of a low-confidence answer. */
    notCertain: string;
    /** Label of the chip that lists the pages the diary consulted. */
    consulted: string;
    /** The real figures of the search, under the listening line. {n}: passages searched, {pages}: the pages that were kept. */
    retrievalLine: string;
    /** {n}: passages searched; no page stood out. */
    retrievalNoPages: string;
    /** Added to the search line when the evidence was weak (the diary says so, quietly). */
    weakMatch: string;
    /** RATE_LIMITED with the daily quota: the model service has nothing more to give today. */
    dailyQuota: string;
    /** RATE_LIMITED otherwise: the reader is writing faster than the diary may answer. */
    slowDown: string;
    /** {n}: seconds the server asked the reader to wait. */
    retryAfter: string;
    /** The button that asks the same question again after a failure. */
    retry: string;
    /** The reply was cut off: the ink ran out. */
    truncated: string;
    /** Mode "passages" (no language model is available): the diary points at pages instead of answering. */
    passages: string;
    /** The diary's line when the reader writes the secret phrase before there is a manuscript. */
    nothingToShow: string;
  };
  citation: {
    /** Research line 20; {n}: a page number. */
    footnote: string;
    /** The handwritten annotation of one page. {n}: the page. */
    page: string;
    /** {from}, {to}: a page range. */
    pages: string;
    /** Accessible name of a citation chip. {n}: the page. */
    show: string;
    /** {from}, {to} */
    showRange: string;
    /** Accessible name of a chip for a page the diary read but did not cite. {n}: the page. */
    showConsulted: string;
  };
  /** The diary's writing leaf (desktop) and sheet (narrow screens). */
  diary: {
    /** Accessible name of the writing field. */
    inputLabel: string;
    write: string;
    /** The gentle counter near the limit. {n}: characters used, {max}: the limit. */
    counter: string;
    counterLabel: string;
    /** Accessible name of the conversation log. */
    log: string;
    /** What the log holds for the question and for the answer. {text}: the words. */
    youWrote: string;
    diaryWrote: string;
    /** {pages}: the pages named, for the log. */
    pagesNamed: string;
    /** The leaf's region name. */
    leafLabel: string;
    /** The name of the scrolling region that holds what has been written (a landmark's name must be its own). */
    pageSoFar: string;
    /** The quill button of the reader's bar and of the flyleaf: the camera dives onto the diary's page. */
    writeInDiary: string;
    /** The way back from the page to the book as a whole. */
    leave: string;
    earlierPage: string;
    laterPage: string;
    /** "Diary page {n} of {total}": where the reader is among the diary's pages. */
    pageNumber: string;
    /** The ribbon that brings the reader back to the page they were writing on after a citation took them to the manuscript. */
    returnToDiary: string;
    /** The small handwritten link under an answer: checks it against the manuscript. */
    showTruth: string;
    /** The heading of the first diary page, where the first question is written. */
    heading: string;
    /** The faint line under an answer: what to do next. */
    nextQuestion: string;
    /** What the diary writes when it is pressed. */
    showTruthLine: string;
    /** The conversation menu. */
    menu: string;
    clear: string;
    clearAsk: string;
    clearConfirm: string;
    clearFailed: string;
  };
  memory: {
    /** Research line 19: the diary's offer, which is also the primary trigger phrase. */
    offer: string;
  };
  /** "Show me the truth": the cited page the diary points to, and the way back. */
  truth: {
    /** Skips the scene (the cited page appears at once). */
    skip: string;
    /** The quill / ribbon control that brings the visitor back to their diary page. */
    returnToPage: string;
    nextPage: string;
    prevPage: string;
    /** {n}: the page number (in the interface's digits). */
    pageLabel: string;
    /** Accessible name of the dialog that shows the cited page. */
    dialogLabel: string;
    /** The page could not be drawn in this browser. */
    imageFailed: string;
  };
  /** The one quiet control in the corner. */
  settings: {
    button: string;
    title: string;
    sound: string;
    reducedMotion: string;
    language: string;
    on: string;
    off: string;
    system: string;
  };
  /** Research lines 16 to 18: the diary's replies when there is no manuscript yet. */
  preUpload: readonly [first: string, second: string, third: string];
  hints: {
    stillReading: string;
    archiveBusy: string;
    /** A file offered while the book is turning its pages (opening the manuscript, a memory, closing). */
    bookBusy: string;
  };
  reader: {
    /** The page indicator at spread 0, where the book shows its bookplate. */
    bookplate: string;
    /** {n}: page number, {total}: page count. */
    pageOf: string;
    /** {from}, {to}: the two pages of the spread, {total}: page count. */
    pagesOf: string;
    /** Accessible name of the page controls. */
    controls: string;
    next: string;
    prev: string;
    /** The button that opens the page jump, and the name of the popover. */
    goToPage: string;
    /** Label of the number field ({first}: the first page, {total}: page count; both in the interface's digits). */
    jumpInput: string;
    jumpGo: string;
    /** {first}, {total} */
    jumpInvalid: string;
    /** {n}: a page number (the name of a thumbnail's button). */
    thumbnail: string;
    /** Toggles one page framed to fill the screen. The label stays the same; `aria-pressed` says whether it is on. */
    readClosely: string;
    /** {pages}: the pages a warning is about. */
    warningPages: string;
    /** The diary menu's button. */
    menu: string;
    /** Puts a note away. */
    dismiss: string;
    /** The pages cannot be drawn in this browser (the diary still answers from them). */
    pagesNotShown: string;
    /** The stored file could not be read again today: the Blob store's read budget is spent (global section S.15). */
    pagesArchiveFull: string;
  };
  /** Questions asked before something the reader cannot undo. */
  confirm: {
    cancel: string;
    offerAnother: { title: string; body: string; confirm: string };
    /** {name}: the dropped file. */
    replace: { title: string; body: string; confirm: string };
    close: { title: string; body: string; confirm: string };
    reset: { title: string; body: string; confirm: string };
  };
  /** Fallback messages the state effects attach to an error when the server or the browser gave none. */
  fallbackErrors: {
    readingInterrupted: string;
    readingFailed: string;
    readyButEmpty: string;
    noManuscript: string;
  };
  spell: {
    failed: string;
    beginAgain: string;
    technicalLabel: string;
  };
  scene: {
    /** Said in place of the technical reason where that reason would be English (the Arabic interface). */
    genericReason: string;
    /** {reason}: the technical reason the immersive view stopped. */
    forcedSimple: string;
    tryImmersiveAgain: string;
    /** {reason}: why this browser cannot draw the 3D diary (WebGL missing or blocked). */
    noWebgl: string;
    /** Accessible name of the button laid over the closed 3D diary. */
    openDiary: string;
    /** The bookplate the diary shows on its first page once it holds a manuscript. */
    bookplate: {
      heading: string;
      pageOne: string;
      /** {n}: the page count. */
      pages: string;
      /** {languages}: the languages of the manuscript. */
      languages: string;
      /** {date}: the day the manuscript was offered. */
      bound: string;
    };
  };
  /** One in-world line for every error code the API or the browser can produce. */
  errors: Record<UiErrorCode, string>;
  /**
   * What a code covers several of, said for the one it is (see api/errorDetail.ts): a full archive is not a busy one, a
   * file refused for its name is not one refused for its first bytes. Used instead of the line of the code.
   */
  errorFlavours: Record<ErrorFlavour, string>;
  warnings: Record<WarningCode, string>;
}
