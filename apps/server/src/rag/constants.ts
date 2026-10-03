import type { Config } from '../config.js';
import { CALIBRATED_THRESHOLDS } from './calibration.generated.js';

/**
 * Every tunable of the RAG pipeline that is not a prompt (prompts live in prompts.ts) and not an environment
 * variable (those are in config.ts). Names say what the number is for.
 */

// --- Retrieval ---------------------------------------------------------------------------------------------

/** Reciprocal Rank Fusion constant: a rank-r hit contributes 1 / (RRF_K + r). 60 is the standard value. */
export const RRF_K = 60;
/** A query token found in more than this share of the document's chunks says nothing: it is dropped (digits excepted). */
export const DF_DROP_RATIO = 0.5;
/** Below this many chunks document frequencies are too coarse to mean anything, so no token is dropped for being common. */
export const MIN_CHUNKS_FOR_DF_FILTER = 6;
/** At most this many tokens go into the lexical query. */
export const MAX_QUERY_TOKENS = 40;
/** A token this short is not searched unless it holds a digit. */
export const MIN_TOKEN_CHARS = 2;
/** Weight of the "page list" in the fusion when the question names pages ("page 12"): it should dominate. */
export const PAGE_LIST_WEIGHT_NAMED = 3;
/** Weight when only the pages the reader is looking at are known and the question points at them ("this page"). */
export const PAGE_LIST_WEIGHT_VISIBLE = 1;
/** A question that names pages gets at most this many of them (a range is cut here). */
export const MAX_NAMED_PAGES = 4;

// --- Evidence gate -----------------------------------------------------------------------------------------

/**
 * Cosine scores of one embedding model sit in a band that depends on the model, so there is no absolute number that means
 * "relevant" across models. A few numbers per model, calibrated on the fixtures with live embeddings by `npm run calibrate`
 * (test/evals/rag-calibration.eval.test.ts measures them, rag/calibration.ts computes them, and the result is written to
 * rag/calibration.generated.ts, which this file reads; the calibration data is kept in .data/task4/calibration.json):
 *  - `floor`: a question in ANOTHER language than the document's, with no INFORMATIVE word match (see `informativeCoverage`),
 *    whose best cosine is below this means the document says nothing about the question, and the answer is "not found" without
 *    calling the model at all (Lab 2's guard 1);
 *  - `sameLanguageFloor`: the same, for a question written in the document's own language. The two floors are independent: a
 *    model may score the same meaning across languages higher or lower, and the data decides (Lab 2: "cross-lingual scores are
 *    lower"). A question whose language, or the document's, is not known gets the lower of the two;
 *  - `strong` / `crossLanguageStrong`: a best cosine at or above this is strong evidence by itself (same language / across);
 *  - `informativeCoverage`: a shared word only vetoes the floor when the best chunk holds at least this share of the question's
 *    idf-weighted words, or when the shared word is a number, an identifier or a proper name ("capital" and "home" are not
 *    evidence that a question about Peru or about bread is covered).
 * A model that has not been calibrated gets no gate on the cosine (floor -1: the gate never fires), so the language model
 * is always asked, with the evidence reported as weak when nothing matched by word.
 */
export interface EvidenceThresholds {
  /** The floor for a question in another language than the document's. */
  floor: number;
  /** The floor for a question in the document's own language. */
  sameLanguageFloor: number;
  /** The strong mark for a question in the document's own language. */
  strong: number;
  /** The strong mark across languages (embedding models score them lower: about 0.05 under the same-language mark). */
  crossLanguageStrong: number;
  /** The share of the question's idf-weighted words the best chunk must hold for a shared word to count as evidence. */
  informativeCoverage: number;
}

const UNCALIBRATED: EvidenceThresholds = {
  floor: -1,
  sameLanguageFloor: -1,
  strong: 2,
  crossLanguageStrong: 2,
  informativeCoverage: 0,
};

/** The best chunk holds at least this share of the question's informative words (idf-weighted): the words are evidence. */
export const STRONG_LEXICAL_COVERAGE = 0.6;

/**
 * Thresholds per embedding model: what `npm run calibrate` last measured (rag/calibration.generated.ts, with the data and the
 * margins on both sides of every number in its header). Models are keyed by id and dimension count.
 */
export const EVIDENCE_THRESHOLDS: Readonly<Record<string, EvidenceThresholds>> = CALIBRATED_THRESHOLDS;

export function evidenceThresholdsFor(embeddingModel: string): EvidenceThresholds {
  return EVIDENCE_THRESHOLDS[embeddingModel] ?? UNCALIBRATED;
}

// --- Answer ------------------------------------------------------------------------------------------------

/** What the model replies, and nothing else, when the excerpts do not contain the answer (Lab 2's sentinel). */
export const NOT_IN_DOCUMENT = 'NOT_IN_DOCUMENT';
/** The first characters of a reply are held back this long while deciding whether they are the sentinel. */
export const SENTINEL_PROBE_CHARS = 24;
/** Matches an excerpt marker such as `[S3]`; always use a fresh `RegExp` from it (global regexes keep state). */
export const MARKER_SOURCE = String.raw`\[S(\d{1,3})\]`;
/** A snippet of a cited chunk shown with a citation. */
export const SNIPPET_MAX_CHARS = 400;
/** What the answer prompt receives of the conversation: at most this many characters of history. */
export const HISTORY_MAX_CHARS = 3000;
/** Comment frame interval of ask and reveal streams (global section E). */
export const ANSWER_HEARTBEAT_MS = 5000;

// --- Grounding check (Lab 2's guard 2) -----------------------------------------------------------------------

/** The yes/no call writes one word; room for a model that adds a few more or spends a few tokens thinking first. */
export const GROUNDING_MAX_TOKENS = 64;
/**
 * The check is advice: when the call takes longer than this it is skipped (it fails open). The clock starts when the request
 * is SENT (after the pacer granted its slot), never while it waits in the queue.
 */
export const GROUNDING_TIMEOUT_MS = 12_000;
/** Lab 2's refusal words: the check refuses only when the reply starts with one of them ("no", "not", Arabic "la", ...). */
export const GROUNDING_NO_WORDS: readonly string[] = ['no', 'not', 'لا', 'ليس', 'غير', 'لم'];

// --- Query rewrite -----------------------------------------------------------------------------------------

export const REWRITE_TIMEOUT_MS = 8000;
export const REWRITE_MAX_TOKENS = 80;
export const REWRITE_MAX_CHARS = 300;

// --- Reveal ------------------------------------------------------------------------------------------------

/** Representative chunks the reveal reads. */
export const REVEAL_MAX_EXCERPTS = 8;
export const REVEAL_MAX_TOKENS = 600;

// --- Output guard ------------------------------------------------------------------------------------------

/** The guard compares word n-grams of the reply with the system prompt. */
export const GUARD_NGRAM_WORDS = 8;
/**
 * A reply is blocked when at least this many of its n-grams, and this share of them, come from the system prompt: 8 grams of 8
 * words is a run of about 15 words copied from the rules, which no honest answer needs; an answer that merely echoes a phrase of
 * a rule or of the mandated sentences (both are left out of the reference) stays far below it.
 */
export const GUARD_MIN_MATCHES = 8;
export const GUARD_OVERLAP_RATIO = 0.3;

// --- The numbers of one pipeline run -------------------------------------------------------------------------

export interface RagSettings {
  topK: number;
  candidates: number;
  contextCharBudget: number;
  historyMessages: number;
  maxTokens: number;
  /** RAG_GROUNDING_CHECK. */
  groundingCheck: boolean;
}

/** The pipeline's numbers: the RAG_* and LLM_* variables of the configuration. */
export function ragSettings(
  config: Pick<
    Config,
    | 'ragTopK'
    | 'ragCandidates'
    | 'ragContextCharBudget'
    | 'ragHistoryMessages'
    | 'ragGroundingCheck'
    | 'llmMaxTokens'
  >,
): RagSettings {
  return {
    topK: config.ragTopK,
    candidates: config.ragCandidates,
    contextCharBudget: config.ragContextCharBudget,
    historyMessages: config.ragHistoryMessages,
    maxTokens: config.llmMaxTokens,
    groundingCheck: config.ragGroundingCheck,
  };
}
