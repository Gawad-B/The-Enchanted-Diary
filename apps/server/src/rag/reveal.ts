import type { AnswerMode, Citation, RefusedBy } from '@enchanted/shared';
import { chunksRepo, type ChunkRow } from '../db/repositories/chunks.js';
import { conversationsRepo } from '../db/repositories/conversations.js';
import { MARKER_SOURCE, REVEAL_MAX_EXCERPTS, REVEAL_MAX_TOKENS, ragSettings } from './constants.js';
import { consultedOf, pipelineError, type Emit, type RagDeps } from './answer.js';
import { citationOf, pagesOf, prepareExcerpts, type PreparedExcerpt } from './excerpts.js';
import { generateReply } from './generate.js';
import { outputBlockedAnswer } from './guard.js';
import { buildRevealMessages, type RevealFocus } from './prompts.js';
import { messageFlags, retrievalRecord } from './record.js';
import { detectQuestionLanguage, languageName } from './language.js';
import { notFoundMessageFor, notFoundText } from './messages.js';
import { pickManuscriptChunks } from './manuscript.js';
import { isInsufficientOnly } from './sentinel.js';
import { fitEvenly } from './sampling.js';

/**
 * `POST /api/documents/:id/reveal`: the "memory". It opens with the manuscript's outline (straight from the database,
 * no model), then the model recalls what the document says:
 *  - focus `answer`: the chunks the latest grounded answer cited are fetched again and the model writes a short memory
 *    of where and how the document says it (with citations); without such an answer it falls back to the manuscript;
 *  - focus `manuscript`: representative chunks (the first of each section, else evenly spaced over the pages) give an
 *    essence and 3 to 5 key points, each with a citation; a key point without a valid citation is dropped.
 * Same events, same defences (excerpts only in the user turn, sanitised and flagged, output guard) and the same
 * persistence as an answer, with kind `reveal`. Without a model: the outline and the passages.
 */

export interface RevealInput {
  document: {
    id: string;
    filename: string;
    pageCount: number;
    primaryLanguage: string;
    sections: { title: string; page: number }[];
    languages: { code: string; share: number }[];
  };
  focus: RevealFocus;
  signal: AbortSignal;
}

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/u;

/** Key points (bullet lines) that carry no marker of this turn are removed; the cited markers are then recounted. */
export function dropUncitedPoints(
  text: string,
  validMarkers: ReadonlySet<string>,
): { text: string; cited: string[] } {
  const hasValidMarker = (line: string): boolean =>
    Array.from(line.matchAll(new RegExp(MARKER_SOURCE, 'gu'))).some((match) =>
      validMarkers.has(`S${match[1] ?? ''}`),
    );
  const kept = text
    .split('\n')
    .filter((line) => !BULLET.test(line) || hasValidMarker(line))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  const cited: string[] = [];
  for (const match of kept.matchAll(new RegExp(MARKER_SOURCE, 'gu'))) {
    const marker = `S${match[1] ?? ''}`;
    if (validMarkers.has(marker) && !cited.includes(marker)) cited.push(marker);
  }
  return { text: kept, cited };
}

interface Picked {
  focus: RevealFocus;
  question: string | null;
  chunks: ChunkRow[];
  searched: number;
}

async function pickChunks(deps: RagDeps, input: RevealInput, max: number): Promise<Picked> {
  const conversationId = await conversationsRepo.find(deps.db, input.document.id);
  if (input.focus === 'answer' && conversationId !== null) {
    const latest = await conversationsRepo.latestGroundedAnswer(deps.db, conversationId);
    if (latest !== null) {
      const ids = latest.answer.citations.map((citation) => citation.chunkId).slice(0, max);
      const rows = new Map(
        (await chunksRepo.byIds(deps.db, input.document.id, ids)).map((row) => [row.id, row]),
      );
      const chunks = ids.flatMap((id) => {
        const row = rows.get(id);
        return row === undefined ? [] : [row];
      });
      if (chunks.length > 0) {
        return {
          focus: 'answer',
          question: latest.question,
          chunks,
          searched: await chunksRepo.count(deps.db, input.document.id),
        };
      }
    }
  }
  const { chunks, searched } = await pickManuscriptChunks(deps.db, input.document.id, max);
  return { focus: 'manuscript', question: null, chunks, searched };
}

/** The refusal sentence: in the language of the question the memory answers, else of the document. */
const refusalIn = (document: { primaryLanguage: string }) => (question: string | null) =>
  question === null ? notFoundMessageFor(document.primaryLanguage) : notFoundText(question);

export async function runReveal(deps: RagDeps, input: RevealInput, emit: Emit): Promise<void> {
  const settings = ragSettings(deps.config);
  const started = performance.now();
  const since = (): number => Math.round(performance.now() - started);
  const { document, signal } = input;
  const refusal = refusalIn(document);
  try {
    // The outline first: it needs no model and shows the manuscript while the memory is being written.
    emit({
      type: 'outline',
      sections: document.sections,
      pageCount: document.pageCount,
      languages: document.languages,
    });
    emit({ type: 'status', stage: 'retrieving', elapsedMs: since() });

    const picked = await pickChunks(deps, input, REVEAL_MAX_EXCERPTS);
    if (signal.aborted) return;
    const fitted = fitEvenly(
      picked.chunks.map((chunk) => chunk.content),
      settings.contextCharBudget,
    );
    const excerpts = prepareExcerpts(
      picked.chunks.map((chunk, index) => ({ chunk, text: fitted[index]?.text ?? chunk.content })),
      document.filename,
    );
    const pages = pagesOf(excerpts);
    const retrievalMs = since();
    emit({
      type: 'retrieval',
      query: picked.question ?? '',
      rewrittenQuery: null,
      searchedChunks: picked.searched,
      retrievedChunks: excerpts.length,
      pages,
      evidence: excerpts.length > 0 ? 'strong' : 'none',
      timingsMs: { embed: 0, semantic: 0, lexical: 0, total: retrievalMs },
    });

    const conversationId = await conversationsRepo.ensure(deps.db, document.id);
    const close = async (
      answer: string,
      mode: AnswerMode,
      grounded: boolean,
      citations: Citation[],
      firstTokenMs: number | null,
      options: {
        blocked?: { reason: string };
        refusedBy?: RefusedBy;
        truncated?: boolean;
        finishReason?: string | null;
      } = {},
    ): Promise<void> => {
      const refusedBy = options.refusedBy ?? null;
      const message = await conversationsRepo.addMessage(deps.db, conversationId, {
        role: 'assistant',
        kind: 'reveal',
        content: answer,
        mode,
        grounded,
        citations,
        retrieval: retrievalRecord({
          query: picked.question ?? picked.focus,
          rewrittenQuery: null,
          evidence: excerpts.length > 0 ? 'strong' : 'none',
          searchedChunks: picked.searched,
          excerpts,
          timings: { embed: 0, semantic: 0, lexical: 0, total: retrievalMs },
          generationMs: { firstToken: firstTokenMs, total: since() },
          llm: deps.llm,
        }),
        flags: messageFlags(excerpts, options.blocked ?? null, refusedBy, {
          ...(options.truncated === undefined ? {} : { truncated: options.truncated }),
          ...(options.finishReason === undefined ? {} : { finishReason: options.finishReason }),
        }),
      });
      emit({ type: 'citations', citations, consulted: consultedOf(pages) });
      emit({
        type: 'done',
        messageId: message.id,
        answer,
        mode,
        grounded,
        refusedBy,
        ...(options.truncated === true ? { truncated: true } : {}),
        timingsMs: { retrieval: retrievalMs, firstToken: firstTokenMs, total: since() },
      });
    };

    if (excerpts.length === 0) {
      await close(refusal(picked.question), 'not_found', false, [], null, { refusedBy: 'evidence' });
      return;
    }
    if (!deps.llm.isConfigured()) {
      const citations = excerpts.map(citationOf);
      await close('', 'passages', true, citations, null);
      return;
    }

    emit({ type: 'status', stage: 'generating', elapsedMs: since() });
    // The memory of an answer is written in the language of the question that was answered (the refusal already is); the
    // memory of the manuscript in the document's.
    const memoryLanguage =
      picked.question === null ? document.primaryLanguage : detectQuestionLanguage(picked.question);
    const prompt = buildRevealMessages({
      focus: picked.focus,
      question: picked.question,
      excerpts,
      document,
      languageName: languageName(memoryLanguage),
      reminderLanguage: memoryLanguage === 'ar' ? 'ar' : 'en',
      ...(deps.canary === undefined ? {} : { canary: deps.canary }),
    });
    const generation = await generateReply(
      {
        llm: deps.llm,
        prompt,
        excerpts,
        maxTokens: Math.min(settings.maxTokens, REVEAL_MAX_TOKENS),
        temperature: deps.config.llmTemperature,
        signal,
        since,
        onText: (text) => emit({ type: 'token', text }),
        ...(deps.canary === undefined ? {} : { canary: deps.canary }),
        ...(picked.question === null ? {} : { question: { text: picked.question, rewrite: null } }),
      },
      deps.log,
    );
    switch (generation.kind) {
      case 'aborted':
        return;
      case 'failed':
        emit({
          type: 'error',
          error: {
            code: generation.code,
            message: generation.message,
            ...(generation.detail === undefined ? {} : { detail: generation.detail }),
          },
        });
        return;
      case 'blocked': {
        const refusal = outputBlockedAnswer(picked.question ?? '');
        emit({ type: 'error', error: { code: 'OUTPUT_BLOCKED', message: refusal } });
        await close(refusal, 'answer', false, [], generation.firstTokenMs, {
          blocked: { reason: generation.verdict.reason },
        });
        return;
      }
      case 'ok': {
        const valid = new Set(excerpts.map((excerpt) => excerpt.id));
        const cleaned = dropUncitedPoints(generation.final.text, valid);
        // The model refuses with the sentinel, with nothing, or with only the mandated sentence (see answer.ts).
        if (generation.final.notFound || cleaned.text === '' || isInsufficientOnly(cleaned.text)) {
          await close(refusal(picked.question), 'not_found', false, [], generation.firstTokenMs, {
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
        const byMarker = new Map<string, PreparedExcerpt>(excerpts.map((excerpt) => [excerpt.id, excerpt]));
        const citations = cleaned.cited.flatMap((marker) => {
          const excerpt = byMarker.get(marker);
          return excerpt === undefined ? [] : [citationOf(excerpt)];
        });
        await close(cleaned.text, 'answer', citations.length > 0, citations, generation.firstTokenMs, {
          ...(generation.truncated
            ? {
                truncated: true,
                ...(generation.finishReason === null ? {} : { finishReason: generation.finishReason }),
              }
            : {}),
        });
        return;
      }
    }
  } catch (error) {
    if (signal.aborted) return;
    deps.log.error({ err: error }, 'the memory could not be written');
    const failure = pipelineError(error);
    emit({
      type: 'error',
      error: {
        ...failure,
        ...(failure.code === 'INTERNAL' ? { message: 'The diary could not finish this memory.' } : {}),
      },
    });
  }
}
