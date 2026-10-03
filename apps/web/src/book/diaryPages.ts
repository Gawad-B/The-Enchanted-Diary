import { createPageSourceRegistry } from './pageSource';

/**
 * Where the textures of the diary's own pages come from (global section T). The book reads every face of the manuscript from
 * the page-source registry (parchment, then the PDF), but a diary page is written by the reader, so it has a source of its
 * own: the scene registers it, and the book asks it for `diary:n` faces.
 */
export const diarySourceRegistry = createPageSourceRegistry();
