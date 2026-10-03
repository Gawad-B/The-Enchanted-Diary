/**
 * The words the reader has begun to write and not yet sent. The writing surface is taken down when the reader steps back from
 * the page, and the draft waits for them here, so a half-written question is still there when they come back. It is never sent
 * anywhere, and goes when the diary closes.
 */
let draft = '';

export const getDraft = (): string => draft;

export const setDraft = (value: string): void => {
  draft = value;
};
