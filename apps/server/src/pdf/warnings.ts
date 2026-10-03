/*
 * pdf.js reports problems it works around as "Warning: ..." lines on console.warn when its verbosity is 1 or more.
 * The ingestion worker opens documents with warnings on for one reason: "Image exceeded maximum allowed size and
 * was removed." is the only way to learn that a page holds an image the extraction limit refused to decode.
 * The sink counts those and swallows every pdf.js warning, so nothing is ever printed by a worker.
 */
const IMAGE_REMOVED = 'Image exceeded maximum allowed size';
let removedImages = 0;

/**
 * Routes pdf.js warnings (it writes them with console.warn) to the sink for the rest of this thread's life, or until
 * the returned function runs. Anything else written to the console passes through.
 */
export function installPdfWarningSink(): () => void {
  const original = console.warn;
  console.warn = (...args: unknown[]): void => {
    const first = args[0];
    if (typeof first === 'string' && first.startsWith('Warning: ')) {
      if (first.includes(IMAGE_REMOVED)) removedImages += 1;
      return;
    }
    original(...args);
  };
  return () => {
    console.warn = original;
  };
}

/** How many images pdf.js refused to decode since the last call; resets the count. */
export function takeRemovedImages(): number {
  const count = removedImages;
  removedImages = 0;
  return count;
}
