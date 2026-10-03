import { facesOnSpread } from '../book/bookLayout';
import type { ReaderState } from './readerStore';

type ReaderView = Pick<
  ReaderState,
  'direction' | 'pageCount' | 'hasDocument' | 'spread' | 'focusSide' | 'narrow' | 'closely'
>;

/**
 * The pages the reader is looking at, ascending, sent along with each question so "this page" can be resolved: both pages of
 * the spread on a wide screen, the one page in view on a narrow screen or while reading closely. The bookplate shows no page,
 * and a blank face past the last page is not one.
 */
export function visiblePagesOf(reader: ReaderView): number[] {
  if (!reader.hasDocument || reader.spread <= 0) return [];
  const faces = facesOnSpread(reader.spread, reader.pageCount, reader.direction, reader.hasDocument);
  const single = (reader.narrow || reader.closely) && reader.focusSide !== null;
  const shown = single && reader.focusSide ? [faces[reader.focusSide]] : [faces.left, faces.right];
  return shown
    .filter((face): face is number => typeof face === 'number' && face >= 1 && face <= reader.pageCount)
    .sort((a, b) => a - b);
}
