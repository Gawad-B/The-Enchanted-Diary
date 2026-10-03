import { normalizeLine } from '../text/normalize.js';
import type { PDFDocumentProxy } from './load.js';

export interface OutlineEntry {
  title: string;
  pageNumber: number;
}

const MAX_ENTRIES = 500;
const MAX_DEPTH = 3;

interface RawOutlineItem {
  title: string;
  dest: string | unknown[] | null;
  items: RawOutlineItem[];
}

/**
 * The document outline (bookmarks) as a flat list of titles with the page they point to, in document order, at
 * most three levels deep. Entries whose destination cannot be resolved are skipped. Empty when the PDF has
 * no outline. Best effort: a damaged outline never fails the document.
 */
export async function readOutline(doc: PDFDocumentProxy): Promise<OutlineEntry[]> {
  let outline: unknown;
  try {
    outline = await doc.getOutline(); // null when the PDF has no outline, whatever the types say
  } catch {
    return [];
  }
  if (!Array.isArray(outline)) return [];
  const root = outline as RawOutlineItem[];

  const entries: OutlineEntry[] = [];
  const visit = async (items: RawOutlineItem[], depth: number): Promise<void> => {
    for (const item of items) {
      if (entries.length >= MAX_ENTRIES) return;
      const pageNumber = await resolvePage(doc, item.dest);
      const title = normalizeLine(item.title);
      if (pageNumber !== null && title !== '') entries.push({ title, pageNumber });
      if (depth < MAX_DEPTH) await visit(item.items, depth + 1);
    }
  };
  await visit(root, 1);
  return entries;
}

async function resolvePage(doc: PDFDocumentProxy, dest: string | unknown[] | null): Promise<number | null> {
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    const target: unknown = explicit?.[0];
    if (target === undefined || target === null) return null;
    const index =
      typeof target === 'number'
        ? target
        : await doc.getPageIndex(target as Parameters<PDFDocumentProxy['getPageIndex']>[0]);
    return Number.isInteger(index) && index >= 0 && index < doc.numPages ? index + 1 : null;
  } catch {
    return null;
  }
}
