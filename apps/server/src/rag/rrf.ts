import { RRF_K } from './constants.js';

const TIE_EPSILON = 1e-12;

export interface RankedList {
  /** Which ranking this is (`semantic`, `lexical`, `page`). */
  name: string;
  /** Chunk ids, best first. */
  ids: readonly string[];
  /** How much this list counts; default 1. */
  weight?: number;
}

export interface FusedItem {
  id: string;
  score: number;
  /** 1-based rank of the id in each list that contains it. */
  ranks: Readonly<Record<string, number>>;
}

/**
 * Reciprocal Rank Fusion: each list gives an item `weight / (k + rank)` and the scores add up. Ranks, not scores,
 * are fused, so lists whose scores mean different things (cosine similarity, idf sums) combine without calibration.
 * An id repeated inside one list counts once, at its best rank. Ties break by the rank in the `tieBreak` lists (in
 * that order), then by the better best-rank, then by the order in which the lists were given: the result is deterministic.
 */
export function reciprocalRankFusion(
  lists: readonly RankedList[],
  k: number = RRF_K,
  /** When two items have the same score, the one with the better rank in the first of these lists wins. */
  tieBreak: readonly string[] = [],
): FusedItem[] {
  const items = new Map<string, { score: number; ranks: Record<string, number>; order: number }>();
  for (const list of lists) {
    const weight = list.weight ?? 1;
    list.ids.forEach((id, index) => {
      const rank = index + 1;
      let item = items.get(id);
      if (item === undefined) {
        item = { score: 0, ranks: {}, order: items.size };
        items.set(id, item);
      }
      if (item.ranks[list.name] !== undefined) return;
      item.ranks[list.name] = rank;
      item.score += weight / (k + rank);
    });
  }
  const bestRank = (ranks: Record<string, number>): number => Math.min(...Object.values(ranks));
  return [...items.entries()]
    .map(([id, item]) => ({ id, score: item.score, ranks: item.ranks, order: item.order }))
    .sort((a, b) => {
      // (scores that differ only by floating-point rounding are ties)
      if (Math.abs(b.score - a.score) > TIE_EPSILON) return b.score - a.score;
      for (const name of tieBreak) {
        const difference = (a.ranks[name] ?? Infinity) - (b.ranks[name] ?? Infinity);
        if (difference !== 0 && !Number.isNaN(difference)) return difference;
      }
      return bestRank(a.ranks) - bestRank(b.ranks) || a.order - b.order;
    })
    .map(({ id, score, ranks }) => ({ id, score, ranks }));
}
