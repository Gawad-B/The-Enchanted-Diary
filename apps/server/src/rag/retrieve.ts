import type { Queryable } from '../db/client.js';
import { chunksRepo, type ChunkRow } from '../db/repositories/chunks.js';
import { embeddingsRepo } from '../db/repositories/embeddings.js';
import { searchRepo } from '../db/repositories/search.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import {
  DF_DROP_RATIO,
  MIN_CHUNKS_FOR_DF_FILTER,
  PAGE_LIST_WEIGHT_NAMED,
  PAGE_LIST_WEIGHT_VISIBLE,
} from './constants.js';
import type { EvidenceSignals } from './evidence.js';
import { detectQuestionLanguage } from './language.js';
import {
  isTaskWord,
  normalizeQuery,
  parsePageReferences,
  properNameForms,
  queryTokens,
  refersToVisiblePages,
  withoutPageVocabulary,
} from './query.js';
import { reciprocalRankFusion, type RankedList } from './rrf.js';

/**
 * THE retrieval module: the ask pipeline and the reveal both read the manuscript through it. Hybrid search over ONE
 * document:
 *   semantic  exact cosine KNN over the document's chunk embeddings (no ANN index: a filtered ANN loses recall, and
 *             a few thousand vectors scan in milliseconds);
 *   lexical   OR of the query's words over the full-text index, weighted by the idf of each word IN THIS DOCUMENT
 *             (a word in over half the chunks is dropped, a rare word such as an identifier or a name counts most);
 *   page      the chunks of the pages the question names ("page 12"), or the pages the reader is looking at when the
 *             question points at them ("this page"), as a boosted third list;
 * fused with Reciprocal Rank Fusion, deduplicated, and cut to the profile's top-k and character budget.
 */

export interface RetrievalDeps {
  db: Queryable;
  embeddings: Pick<EmbeddingProvider, 'model' | 'embedQuery'>;
  /** Where a best-effort step that failed says so (the embedding of the heuristic join). */
  log?: { warn(object: object, message: string): void };
}

export type RetrievalMode = 'hybrid' | 'semantic' | 'lexical';

export interface RetrieveInput {
  documentId: string;
  /** The question as the visitor typed it: what the pages, the shared words and the evidence gate are judged on. */
  query: string;
  /**
   * The standalone rewrite of a follow-up (the language model's, or the heuristic join when it failed): the semantic search
   * embeds it instead of `query`. It is RETRIEVAL-ONLY: its words and pages count for the gate and the page boost only when
   * `rewriteSucceeded`, so that a failed rewrite cannot let the previous question decide what this one is about.
   */
  rewrittenQuery?: string | null;
  /** The language model wrote `rewrittenQuery` (it is not the fallback join). */
  rewriteSucceeded?: boolean;
  topK: number;
  candidates: number;
  contextCharBudget: number;
  pageCount: number;
  /** The pages the reader is looking at. */
  visiblePages?: readonly number[];
  /** Only the benchmark asks for one channel alone. */
  mode?: RetrievalMode;
  signal?: AbortSignal;
}

export interface RetrievedChunk {
  chunk: ChunkRow;
  /** The part of the chunk that goes to the model: all of it, or its start when the budget ran out. */
  text: string;
  truncated: boolean;
  semanticRank: number | null;
  lexicalRank: number | null;
  pageRank: number | null;
  /** Cosine similarity of the semantic search. */
  semanticScore: number | null;
  /** Sum of the idf of the matched words. */
  lexicalScore: number | null;
  rrfScore: number;
}

export interface RetrievalTimings {
  embed: number;
  semantic: number;
  lexical: number;
  total: number;
}

/** What retrieval knows for the evidence gate; the caller adds whether the question is in the document's language. */
export type RetrievalSignals = Omit<EvidenceSignals, 'sameLanguage'>;

/** Why the semantic channel could not run: kept for the log and the stored record (never shown). */
export interface DegradedRetrieval {
  /** The failure of the query embedding. */
  error: unknown;
}

export interface RetrievalOutcome {
  chunks: RetrievedChunk[];
  /** How many chunks the document has: what was searched. */
  searchedChunks: number;
  signals: RetrievalSignals;
  /** The cosine similarity of every semantic candidate, best first (what the evidence gate and its calibration read). */
  semanticScores: number[];
  /** The words that were searched, and the pages the question named. */
  tokens: string[];
  namedPages: number[];
  timings: RetrievalTimings;
  /** Set when the query could not be embedded and the chunks come from words and pages alone (see `degraded` in the signals). */
  degraded?: DegradedRetrieval;
}

const MIN_TRUNCATED_CHARS = 400;
const IDF_TERM = (total: number, df: number): number => Math.log(1 + (total - df + 0.5) / (df + 0.5));
const HAS_DIGIT = /\p{N}/u;
const elapsed = (since: number): number => Math.round((performance.now() - since) * 10) / 10;

/** The start of `text` within `limit` characters, cut at a sentence end or a word edge, with an ellipsis. */
export function truncateAtBoundary(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('\n'), head.lastIndexOf('。'));
  const word = head.lastIndexOf(' ');
  const cut = sentence > limit * 0.5 ? sentence + 1 : word > limit * 0.5 ? word : limit;
  return `${head.slice(0, cut).trimEnd()}…`;
}

export interface BudgetItem {
  chunk: ChunkRow;
}

/**
 * Walks chunks in rank order and keeps the ones that fit: at most `topK`, within `budget` characters. The first
 * chunk is always kept (cut to the budget if it is longer); a later chunk that does not fit whole is cut when at
 * least MIN_TRUNCATED_CHARS remain, otherwise the walk stops. Shared by ask and reveal.
 */
export function capByBudget<T extends BudgetItem>(
  ranked: readonly T[],
  topK: number,
  budget: number,
): (T & { text: string; truncated: boolean })[] {
  const kept: (T & { text: string; truncated: boolean })[] = [];
  let used = 0;
  for (const item of ranked) {
    if (kept.length >= topK) break;
    const content = item.chunk.content;
    const remaining = budget - used;
    if (content.length <= remaining) {
      kept.push({ ...item, text: content, truncated: false });
      used += content.length;
      continue;
    }
    if (kept.length === 0 || remaining >= MIN_TRUNCATED_CHARS) {
      kept.push({ ...item, text: truncateAtBoundary(content, Math.max(remaining, 1)), truncated: true });
    }
    break; // the budget is spent
  }
  return kept;
}

export async function retrieve(deps: RetrievalDeps, input: RetrieveInput): Promise<RetrievalOutcome> {
  const started = performance.now();
  const { db } = deps;
  const mode = input.mode ?? 'hybrid';
  const question = normalizeQuery(input.query);
  const standalone = normalizeQuery(input.rewrittenQuery ?? input.query);
  const searchedChunks = await chunksRepo.count(db, input.documentId);
  const timings: RetrievalTimings = { embed: 0, semantic: 0, lexical: 0, total: 0 };
  const empty = (): RetrievalOutcome => ({
    chunks: [],
    searchedChunks,
    signals: {
      lexicalHit: false,
      lexicalCoverage: 0,
      identifierHit: false,
      properNameHit: false,
      pageOnly: false,
      topCosine: null,
      hasChunks: searchedChunks > 0,
    },
    semanticScores: [],
    tokens: [],
    namedPages: [],
    timings: { ...timings, total: elapsed(started) },
  });
  if (searchedChunks === 0) return empty();

  // Which pages does the question name? They are cut out of the text so that "12" is not searched as a word.
  // The pages come from the question itself; the rewrite's only when the model wrote it (a failed rewrite is the previous
  // question glued on: its "page 2" is not this question's).
  const named = parsePageReferences(question, input.pageCount);
  const namedFromRewrite =
    input.rewriteSucceeded === true
      ? parsePageReferences(standalone, input.pageCount)
      : { pages: [] as number[], remainder: '' };
  const namedPages = named.pages.length > 0 ? named.pages : namedFromRewrite.pages;
  const visible =
    namedPages.length === 0 && refersToVisiblePages(question)
      ? (input.visiblePages ?? []).filter((page) => page >= 1 && page <= input.pageCount)
      : [];
  const pageHints = namedPages.length > 0 ? namedPages : visible;

  // --- semantic: exact KNN ---
  let semantic: { chunkId: string; score: number }[] = [];
  let semanticFailure: DegradedRetrieval | undefined;
  // What guard 1 reads is the cosine of the question the visitor asked, or of the model's rewrite of it. A failed rewrite is the
  // previous question glued on (`joined`): it may WIDEN the candidates but never decides guard 1, or the previous question
  // would carry an off-topic follow-up past the gate.
  const joined = input.rewrittenQuery != null && standalone !== question && input.rewriteSucceeded !== true;
  const gateText = joined ? question : standalone;
  let widening: { chunkId: string; score: number }[] = [];
  if (mode !== 'lexical') {
    const embedStarted = performance.now();
    try {
      const vector = await deps.embeddings.embedQuery(gateText, input.signal);
      timings.embed = elapsed(embedStarted);
      const semanticStarted = performance.now();
      semantic = await embeddingsRepo.nearest(
        db,
        input.documentId,
        deps.embeddings.model,
        vector,
        input.candidates,
      );
      timings.semantic = elapsed(semanticStarted);
      if (joined) {
        // best effort: without the join's embedding the search simply has fewer candidates
        try {
          const joinedVector = await deps.embeddings.embedQuery(standalone, input.signal);
          widening = await embeddingsRepo.nearest(
            db,
            input.documentId,
            deps.embeddings.model,
            joinedVector,
            input.candidates,
          );
        } catch (error) {
          if (input.signal?.aborted === true) throw error;
          deps.log?.warn(
            { err: error },
            'the joined follow-up could not be embedded: the search has fewer candidates',
          );
        }
      }
    } catch (error) {
      // The visitor going away, and a benchmark of the semantic channel alone, are not degradations: they end the call.
      if (input.signal?.aborted === true || mode === 'semantic') throw error;
      timings.embed = elapsed(embedStarted);
      semanticFailure = { error };
    }
  }

  // --- lexical: idf-weighted OR over the full-text index ---
  const lexicalStarted = performance.now();
  // The words are the question's own, plus the rewrite's when the model wrote it (the rewrite resolves "it" and "he").
  const tokens = queryTokens(
    named.remainder,
    ...(input.rewriteSucceeded === true ? [namedFromRewrite.remainder] : []),
  );
  // Capitalisation says nothing in German (every noun has one): no proper names there.
  const properNames =
    detectQuestionLanguage(question) === 'de' ? new Map<string, string>() : properNameForms(question);
  let lexicalHit = false;
  let identifierHit = false;
  let properNameHit = false;
  let lexicalCoverage = 0;
  let lexical: { chunkId: string; score: number }[] = [];
  if (tokens.length > 0) {
    const frequencies = await searchRepo.documentFrequencies(db, input.documentId, tokens);
    const hits = frequencies.filter((entry) => entry.df > 0);
    lexicalHit = hits.length > 0;
    identifierHit = hits.some((entry) => HAS_DIGIT.test(entry.token));
    // a name counts only when the document writes it with a capital too ("Peru" is in it, "capital" is not "Capital")
    const nameCandidates = hits.flatMap((entry) => {
      const surface = properNames.get(entry.token);
      return surface === undefined ? [] : [surface];
    });
    properNameHit =
      nameCandidates.length > 0 &&
      (await searchRepo.capitalisedForms(db, input.documentId, nameCandidates)).size > 0;
    if (mode !== 'semantic') {
      const filterByFrequency = searchedChunks >= MIN_CHUNKS_FOR_DF_FILTER;
      // Too common to say anything: in over half the chunks (numbers excepted).
      const informative = frequencies.filter(
        (entry) =>
          !filterByFrequency || entry.df / searchedChunks <= DF_DROP_RATIO || HAS_DIGIT.test(entry.token),
      );
      const weighted = informative
        .filter((entry) => entry.df > 0)
        .map((entry) => ({ token: entry.token, idf: IDF_TERM(searchedChunks, entry.df) }));
      lexical = await searchRepo.lexicalCandidates(db, input.documentId, weighted, input.candidates);
      // How much of what the question is about the best chunk contains: its idf-weighted share of the question's
      // informative words, a word the document does not have at all counting as the most informative of all.
      // (a word of a REQUEST that the document does not have, "summarize", is not a word the document failed to cover)
      const asked = informative
        .filter((entry) => !(entry.df === 0 && isTaskWord(entry.token)))
        .reduce((sum, entry) => sum + IDF_TERM(searchedChunks, entry.df), 0);
      lexicalCoverage = asked > 0 ? Math.min(1, (lexical[0]?.score ?? 0) / asked) : 0;
    }
  }
  let pageIds: string[] = [];
  if (pageHints.length > 0 && mode !== 'semantic') {
    pageIds = (await searchRepo.chunksOnPages(db, input.documentId, pageHints)).map((row) => row.chunkId);
  }
  timings.lexical = elapsed(lexicalStarted);

  // --- fuse, deduplicate, cut ---
  const lists: RankedList[] = [];
  if (mode !== 'lexical') lists.push({ name: 'semantic', ids: semantic.map((hit) => hit.chunkId) });
  if (widening.length > 0) lists.push({ name: 'joined', ids: widening.map((hit) => hit.chunkId) });
  if (mode !== 'semantic') lists.push({ name: 'lexical', ids: lexical.map((hit) => hit.chunkId) });
  if (pageIds.length > 0) {
    lists.push({
      name: 'page',
      ids: pageIds,
      weight: namedPages.length > 0 ? PAGE_LIST_WEIGHT_NAMED : PAGE_LIST_WEIGHT_VISIBLE,
    });
  }
  // On equal scores the chunk the words point at wins: an exact name is better evidence than a vague similarity.
  const fused = reciprocalRankFusion(lists, undefined, ['lexical', 'semantic']);
  const wanted = fused.slice(0, Math.max(input.topK * 3, 12));
  const rows = new Map(
    (
      await chunksRepo.byIds(
        db,
        input.documentId,
        wanted.map((item) => item.id),
      )
    ).map((row) => [row.id, row]),
  );
  const semanticScores = new Map([...widening, ...semantic].map((hit) => [hit.chunkId, hit.score]));
  const lexicalScores = new Map(lexical.map((hit) => [hit.chunkId, hit.score]));
  const ranked = wanted.flatMap((item) => {
    const chunk = rows.get(item.id);
    return chunk === undefined
      ? []
      : [
          {
            chunk,
            semanticRank: item.ranks.semantic ?? null,
            lexicalRank: item.ranks.lexical ?? null,
            pageRank: item.ranks.page ?? null,
            semanticScore: semanticScores.get(item.id) ?? null,
            lexicalScore: lexicalScores.get(item.id) ?? null,
            rrfScore: item.score,
          },
        ];
  });
  const chunks = capByBudget(ranked, input.topK, input.contextCharBudget);
  // The semantic channel failed and nothing else found anything: the honest answer is the failure itself, not "not in the
  // document" (a paraphrase, or a question in another language, has no word to find).
  if (semanticFailure !== undefined && chunks.length === 0) throw semanticFailure.error;

  timings.total = elapsed(started);
  return {
    chunks,
    searchedChunks,
    signals: {
      lexicalHit,
      lexicalCoverage,
      identifierHit,
      properNameHit,
      // A question that names a page that exists ("page 4"), or points at the page the reader is looking at ("this page"),
      // and asks nothing else, points straight at its evidence. A question that names a page AND asks something ("does page 1
      // mention online programs?") only gets the page's chunks boosted: it still has to pass the gate and the grounding check.
      // (judged on the question that NAMES the pages: a rewrite's pages carry the rewrite's remainder, so "tell me more"
      // after "does page 1 mention online programs?" is not a request that only points at a page)
      pageOnly:
        pageIds.length > 0 &&
        queryTokens(
          withoutPageVocabulary(
            named.pages.length > 0 || visible.length > 0 ? named.remainder : namedFromRewrite.remainder,
          ),
        ).length === 0,
      topCosine: semantic[0]?.score ?? null,
      hasChunks: true,
      ...(semanticFailure === undefined ? {} : { degraded: true }),
    },
    semanticScores: semantic.map((hit) => hit.score),
    tokens,
    namedPages,
    timings,
    ...(semanticFailure === undefined ? {} : { degraded: semanticFailure }),
  };
}
