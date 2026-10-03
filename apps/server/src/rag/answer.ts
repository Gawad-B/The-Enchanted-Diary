import type {
  AnswerMode,
  AnswerStreamEvent,
  Citation,
  ErrorCode,
  Evidence,
  RefusedBy,
} from '@enchanted/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { conversationsRepo, type MessageRow } from '../db/repositories/conversations.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { DAILY_QUOTA_DETAIL } from '../gemini/index.js';
import type { LLMProvider } from '../llm/provider.js';
import {
  REVEAL_MAX_EXCERPTS,
  evidenceThresholdsFor,
  ragSettings,
  type EvidenceThresholds,
} from './constants.js';
import { assessEvidence } from './evidence.js';
import { citationOf, pagesOf, prepareExcerpts, type PreparedExcerpt } from './excerpts.js';
import { generateReply } from './generate.js';
import { checkGrounding, type GroundingResult } from './grounding.js';
import { outputBlockedAnswer } from './guard.js';
import { buildHistory } from './history.js';
import { detectQuestionLanguage, isSameLanguage } from './language.js';
import { manuscriptOutcome } from './manuscript.js';
import { notFoundText } from './messages.js';
import { buildAnswerMessages } from './prompts.js';
import { isMetaQuestion } from './query.js';
import { messageFlags, retrievalRecord } from './record.js';
import { heuristicRewrite, rewriteQuery, type RewriteResult } from './rewrite.js';
import { retrieve, type RetrievalOutcome } from './retrieve.js';
import { isInsufficientOnly } from './sentinel.js';

/** Everything the answer and reveal pipelines need from the rest of the server. */
export interface RagDeps {
  db: Db;
  config: Config;
  embeddings: Pick<EmbeddingProvider, 'model' | 'embedQuery' | 'reportsSend'>;
  llm: LLMProvider;
  log: {
    warn(object: object, message: string): void;
    error(object: object, message: string): void;
    /** Notes that are no fault (an answer lost a sentence that cited nothing); a logger without it says nothing of them. */
    info?(object: object, message: string): void;
  };
  /** Replaces the calibrated evidence thresholds of the embedding model (tests with a stand-in model). */
  evidence?: EvidenceThresholds;
  /** Replaces the process canary of the system prompts (tests). */
  canary?: string;
}

export type Emit = (event: AnswerStreamEvent) => void;

export interface AskInput {
  document: { id: string; filename: string; pageCount: number; primaryLanguage: string };
  question: string;
  /** The pages the reader is looking at. */
  visiblePages?: readonly number[];
  /** Aborted when the visitor's connection closes. */
  signal: AbortSignal;
}

export const consultedOf = (pages: readonly number[]): { page: number }[] => pages.map((page) => ({ page }));

const INTERNAL_MESSAGE = 'The diary could not finish this answer.';

export interface PipelineError {
  code: ErrorCode;
  message: string;
  detail?: string;
}

/** The error event for a failure of the pipeline itself (database, embeddings): curated, never the raw message. */
export function pipelineError(error: unknown): PipelineError {
  if (error instanceof Error && error.name === 'EmbeddingError') {
    const embedding = error as Error & {
      rateLimited?: boolean;
      dailyQuota?: boolean;
      unconfigured?: boolean;
    };
    if (embedding.unconfigured === true) {
      return { code: 'EMBEDDING_FAILED', message: 'The search model is not configured on this server.' };
    }
    if (embedding.rateLimited === true) {
      return {
        code: 'RATE_LIMITED',
        message:
          embedding.dailyQuota === true
            ? 'The daily request limit of the search model has been reached.'
            : 'The search model is busy right now; try again in a moment.',
        ...(embedding.dailyQuota === true ? { detail: DAILY_QUOTA_DETAIL } : {}),
      };
    }
    return { code: 'EMBEDDING_FAILED', message: 'The question could not be understood by the search model.' };
  }
  return { code: 'INTERNAL', message: INTERNAL_MESSAGE };
}

/**
 * `POST /api/documents/:id/ask`, as a function of events (Lab 2's three guards, around retrieval): rewrite (follow-ups)
 * -> retrieve -> guard 1, the evidence gate -> guard 2, the grounding check -> the model -> guard 3, the model's own
 * refusal -> citations -> done, persisting the question and the answer. The HTTP route only turns `emit` into SSE frames.
 *
 *  - The rewrite is RETRIEVAL-ONLY: the semantic search embeds it, but the pages, the shared words and the evidence gate are
 *    judged on the question as typed (plus the rewrite's words when the model wrote it); the grounding check is asked the
 *    model's rewrite (it resolves "it"), else the question as typed.
 *  - A question about the document as a whole ("what is this about?", "summarise it") reads the manuscript overview instead of
 *    a search: no passage answers it, so guard 1 is skipped; guards 2 and 3 still apply.
 *  - Not found, without calling the answer model, when the document has no chunks or the gate sees no evidence
 *    (`refusedBy: 'evidence'`), or when the grounding check says the excerpts do not hold the answer (`'grounding'`).
 *  - Not found when the model itself refuses (`'model'`): the sentinel NOT_IN_DOCUMENT, nothing at all, or only the mandated
 *    "the document does not provide enough information".
 *  - Passages (no answer text, the citations are the passages) when no model is configured.
 *  - A failure of the model is an `error` event; the visitor's question is stored all the same.
 *  - Closing the connection aborts the model; nothing more is sent or stored.
 */
export async function runAsk(deps: RagDeps, input: AskInput, emit: Emit): Promise<void> {
  const settings = ragSettings(deps.config);
  const started = performance.now();
  const since = (): number => Math.round(performance.now() - started);
  const { document, question, signal } = input;
  // (a function: TypeScript would take `signal.aborted` to stay false after the first check)
  const gone = (): boolean => signal.aborted;
  try {
    const conversationId = await conversationsRepo.ensure(deps.db, document.id);
    const earlier = await conversationsRepo.recent(deps.db, conversationId, settings.historyMessages, [
      'question',
      'answer',
    ]);
    await conversationsRepo.addMessage(deps.db, conversationId, {
      role: 'user',
      kind: 'question',
      content: question,
    });
    const history = buildHistory(earlier, { maxMessages: settings.historyMessages });
    const previousQuestion = [...earlier].reverse().find((row) => row.role === 'user')?.content ?? null;
    // The language of the prompts is the question's. A question nothing tells (`und`: "Peru?") is asked for in "the language of
    // the question", never in a silent English; the diary's own refusal sentence then falls back to the document's language.
    const language = detectQuestionLanguage(question);
    // a follow-up's pronoun is its topic ("what does the document say about it?"): the previous question gives it a meaning
    const followUp = previousQuestion !== null && settings.historyMessages > 0;
    const meta = isMetaQuestion(question, { followUp });

    // --- follow-ups are made searchable ---
    let rewrite: RewriteResult | null = null;
    // (RAG_HISTORY_MESSAGES=0 switches conversation context off altogether: nothing to resolve "it" from; a question about the
    // document as a whole needs no resolving either)
    if (followUp && !meta) {
      if (deps.llm.isConfigured()) {
        emit({ type: 'status', stage: 'rewriting', elapsedMs: since() });
        rewrite = await rewriteQuery(deps.llm, { question, history, previousQuestion, signal });
        if (rewrite.source === 'heuristic') {
          deps.log.warn(
            { reason: rewrite.reason, error: rewrite.error },
            'the follow-up was not rewritten by the model: the questions are joined instead',
          );
        }
      } else {
        rewrite = {
          query: heuristicRewrite(previousQuestion, question),
          source: 'heuristic',
          reason: null,
        };
      }
    }
    if (gone()) return;

    // --- retrieval and guard 1, the evidence gate ---
    emit({ type: 'status', stage: 'retrieving', elapsedMs: since() });
    const retrieval: RetrievalOutcome = meta
      ? await manuscriptOutcome(deps.db, document.id, {
          max: REVEAL_MAX_EXCERPTS,
          budget: settings.contextCharBudget,
        })
      : await retrieve(
          { db: deps.db, embeddings: deps.embeddings, log: deps.log },
          {
            documentId: document.id,
            query: question,
            rewrittenQuery: rewrite?.query ?? null,
            rewriteSucceeded: rewrite?.source === 'llm',
            topK: settings.topK,
            candidates: settings.candidates,
            contextCharBudget: settings.contextCharBudget,
            pageCount: document.pageCount,
            ...(input.visiblePages === undefined ? {} : { visiblePages: input.visiblePages }),
            signal,
          },
        );
    if (gone()) return;
    if (retrieval.degraded !== undefined) {
      deps.log.warn(
        { err: retrieval.degraded.error },
        'the question could not be embedded: answering from words and pages alone',
      );
    }
    const evidence = assessEvidence(
      { ...retrieval.signals, sameLanguage: isSameLanguage(question, document.primaryLanguage) },
      deps.evidence ?? evidenceThresholdsFor(deps.embeddings.model),
    );
    const excerpts = prepareExcerpts(
      retrieval.chunks.map((entry) => ({ chunk: entry.chunk, text: entry.text, retrieved: entry })),
      document.filename,
    );
    const pages = pagesOf(excerpts);
    const retrievalMs = since();
    emit({
      type: 'retrieval',
      query: question,
      rewrittenQuery: rewrite?.query ?? null,
      searchedChunks: retrieval.searchedChunks,
      retrievedChunks: excerpts.length,
      pages,
      evidence,
      timingsMs: retrieval.timings,
    });

    const turn = new Turn(deps, conversationId, {
      question,
      language: document.primaryLanguage,
      rewrite,
      meta,
      evidence,
      retrieval,
      excerpts,
      pages,
      retrievalMs,
      since,
      emit,
    });

    if (evidence === 'none') {
      await turn.finishWithoutModel('not_found');
      return;
    }
    if (!deps.llm.isConfigured()) {
      await turn.finishWithoutModel('passages');
      return;
    }

    // --- guard 2, the grounding check (a question that only names a page was pointed at its evidence: no check) ---
    emit({ type: 'status', stage: 'generating', elapsedMs: since() });
    if (settings.groundingCheck && !retrieval.signals.pageOnly) {
      const result = await checkGrounding(deps.llm, {
        // the model's rewrite resolves "it"; the fallback join would ask about two questions at once
        question: rewrite?.source === 'llm' ? rewrite.query : question,
        excerpts,
        document,
        language,
        signal,
      });
      if (gone()) return;
      turn.grounding = result;
      if (result.verdict === 'skipped') {
        // Fail open, but never silently: the reason is logged and stored with the answer.
        deps.log.warn(
          { reason: result.reason, error: result.error },
          'the grounding check was skipped: the question goes to the answer model unchecked',
        );
      }
      if (result.verdict === 'no') {
        await turn.finishWithoutModel('not_found', 'grounding');
        return;
      }
    }

    // --- the model, and guard 3, its own refusal ---
    const prompt = buildAnswerMessages({
      question,
      history,
      excerpts,
      document,
      evidence,
      language,
      ...(deps.canary === undefined ? {} : { canary: deps.canary }),
    });
    const generation = await generateReply(
      {
        llm: deps.llm,
        prompt,
        excerpts,
        maxTokens: settings.maxTokens,
        temperature: deps.config.llmTemperature,
        signal,
        since,
        onText: (text) => emit({ type: 'token', text }),
        ...(deps.canary === undefined ? {} : { canary: deps.canary }),
        // the words an uncited statement of the document's silence must be about: the question as typed, and its rewrite when the model
        // wrote it (a heuristic join of two questions says nothing the visitor did not)
        question: { text: question, rewrite: rewrite?.source === 'llm' ? rewrite.query : null },
      },
      deps.log,
    );
    await turn.finishWithGeneration(generation);
  } catch (error) {
    if (signal.aborted) return;
    deps.log.error({ err: error }, 'the question could not be answered');
    emit({ type: 'error', error: pipelineError(error) });
  }
}

interface TurnState {
  question: string;
  /** The document's language (the refusal's language when the question's is not known). */
  language: string;
  rewrite: RewriteResult | null;
  meta: boolean;
  evidence: Evidence;
  retrieval: RetrievalOutcome;
  excerpts: PreparedExcerpt[];
  pages: number[];
  retrievalMs: number;
  since: () => number;
  emit: Emit;
}

interface CloseOptions {
  blocked?: { reason: string };
  refusedBy?: RefusedBy;
  truncated?: boolean;
  finishReason?: string | null;
  uncitedLinesDropped?: number;
}

/** The ways an ask ends: each sends its closing events and stores the assistant message. */
class Turn {
  /** What the grounding check said (`null`: it did not run). */
  grounding: GroundingResult | null = null;

  constructor(
    private readonly deps: RagDeps,
    private readonly conversationId: string,
    private readonly state: TurnState,
  ) {}

  private async store(
    content: string,
    mode: AnswerMode,
    grounded: boolean,
    citations: Citation[],
    firstTokenMs: number | null,
    options: CloseOptions,
  ): Promise<MessageRow> {
    const { state } = this;
    return conversationsRepo.addMessage(this.deps.db, this.conversationId, {
      role: 'assistant',
      kind: 'answer',
      content,
      mode,
      grounded,
      citations,
      retrieval: retrievalRecord({
        query: state.question,
        rewrittenQuery: state.rewrite?.query ?? null,
        evidence: state.evidence,
        searchedChunks: state.retrieval.searchedChunks,
        excerpts: state.excerpts,
        timings: state.retrieval.timings,
        generationMs: { firstToken: firstTokenMs, total: state.since() },
        llm: this.deps.llm,
        grounding: this.grounding?.verdict ?? null,
        groundingReason: this.grounding?.reason ?? null,
        groundingError: this.grounding?.error?.code ?? null,
        rewriteSource: state.rewrite?.source ?? null,
        rewriteReason: state.rewrite?.reason ?? null,
        meta: state.meta,
        degraded: state.retrieval.degraded !== undefined,
      }),
      flags: messageFlags(state.excerpts, options.blocked ?? null, options.refusedBy ?? null, {
        ...(options.truncated === undefined ? {} : { truncated: options.truncated }),
        ...(options.finishReason === undefined ? {} : { finishReason: options.finishReason }),
        ...(options.uncitedLinesDropped === undefined
          ? {}
          : { uncitedLinesDropped: options.uncitedLinesDropped }),
      }),
    });
  }

  private async close(
    answer: string,
    mode: AnswerMode,
    grounded: boolean,
    citations: Citation[],
    firstTokenMs: number | null,
    options: CloseOptions = {},
  ): Promise<void> {
    const { state } = this;
    const refusedBy = options.refusedBy ?? null;
    const message = await this.store(answer, mode, grounded, citations, firstTokenMs, options);
    state.emit({ type: 'citations', citations, consulted: consultedOf(state.pages) });
    state.emit({
      type: 'done',
      messageId: message.id,
      answer,
      mode,
      grounded,
      refusedBy,
      ...(options.truncated === true ? { truncated: true } : {}),
      timingsMs: { retrieval: state.retrievalMs, firstToken: firstTokenMs, total: state.since() },
    });
  }

  /** The refusal sentence, in the language of the question (else of the document, else English). */
  private refusal(): string {
    return notFoundText(this.state.question, this.state.language);
  }

  /** Not found (a guard refused before the answer model was asked) or passages (no model): no answer was written. */
  async finishWithoutModel(mode: 'not_found' | 'passages', refusedBy: RefusedBy = 'evidence'): Promise<void> {
    const { state } = this;
    if (mode === 'not_found') {
      await this.close(this.refusal(), 'not_found', false, [], null, { refusedBy });
      return;
    }
    // The passages are the answer: every retrieved excerpt is a citation, and no sentence is written about them.
    const citations = state.excerpts.map(citationOf);
    await this.close('', 'passages', citations.length > 0, citations, null);
  }

  async finishWithGeneration(generation: Awaited<ReturnType<typeof generateReply>>): Promise<void> {
    const { state } = this;
    switch (generation.kind) {
      case 'aborted':
        return;
      case 'failed':
        state.emit({
          type: 'error',
          error: {
            code: generation.code,
            message: generation.message,
            ...(generation.detail === undefined ? {} : { detail: generation.detail }),
          },
        });
        return;
      case 'blocked': {
        // The reply is replaced by an in-world refusal; the error says why. Tokens already sent are replaced by `done.answer`.
        const refusal = outputBlockedAnswer(state.question);
        state.emit({ type: 'error', error: { code: 'OUTPUT_BLOCKED', message: refusal } });
        await this.close(refusal, 'answer', false, [], generation.firstTokenMs, {
          blocked: { reason: generation.verdict.reason },
        });
        return;
      }
      case 'ok': {
        const { final } = generation;
        // Lab 2's guard 3: the model refuses by replying with the sentinel, with nothing, or with only the mandated sentence;
        // the diary answers with its own refusal in the language of the question.
        if (final.notFound || final.text === '' || isInsufficientOnly(final.text)) {
          if (!final.notFound) {
            this.deps.log.warn(
              { finishReason: generation.finishReason, empty: final.text === '' },
              'the model gave no answer: treated as a refusal',
            );
          }
          await this.close(this.refusal(), 'not_found', false, [], generation.firstTokenMs, {
            refusedBy: 'model',
            ...(generation.truncated
              ? {
                  truncated: true,
                  ...(generation.finishReason === null ? {} : { finishReason: generation.finishReason }),
                }
              : {}),
          });
          return;
        }
        const byMarker = new Map(state.excerpts.map((excerpt) => [excerpt.id, excerpt]));
        const citations = final.cited.flatMap((marker) => {
          const excerpt = byMarker.get(marker);
          return excerpt === undefined ? [] : [citationOf(excerpt)];
        });
        // Sentences that cited nothing were dropped (a flourish, in every stored live answer): counted per answer, so that a drop that
        // took a fact would show in the logs of the first run where it happens (no text is logged)
        if (final.droppedUncitedLines > 0) {
          this.deps.log.info?.(
            { uncitedSentencesDropped: final.droppedUncitedLines, citedMarkers: final.cited.length },
            'sentences that cited nothing were dropped from the answer',
          );
        }
        // An answer that cites nothing is shown, but not as grounded; `consulted` still says which pages were read.
        await this.close(final.text, 'answer', citations.length > 0, citations, generation.firstTokenMs, {
          // the provider's stop reason is kept only for a reply that did not end of itself
          ...(generation.truncated
            ? {
                truncated: true,
                ...(generation.finishReason === null ? {} : { finishReason: generation.finishReason }),
              }
            : {}),
          ...(final.droppedUncitedLines > 0 ? { uncitedLinesDropped: final.droppedUncitedLines } : {}),
        });
        return;
      }
    }
  }
}
