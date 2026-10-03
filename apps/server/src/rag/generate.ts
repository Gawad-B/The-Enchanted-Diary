import type { ErrorCode } from '@enchanted/shared';
import { LlmError, isAbortError, type LLMProvider } from '../llm/provider.js';
import type { PreparedExcerpt } from './excerpts.js';
import { OutputGuard, type GuardVerdict } from './guard.js';
import { GUARD_ALLOWED_PHRASES, PROCESS_CANARY, type BuiltPrompt } from './prompts.js';
import { ReplyProcessor, finalizeReply, type FinalReply } from './reply.js';
import { questionContext } from './silence.js';

export type Generation =
  | {
      kind: 'ok';
      raw: string;
      final: FinalReply;
      firstTokenMs: number | null;
      /** The reply was cut off (the output limit, or a filter that stopped it after some text). */
      truncated: boolean;
      /** The provider's own stop reason, for the log and the stored record (null when it has none or the reply was not asked). */
      finishReason: string | null;
    }
  /** The output guard stopped the reply (canary or system-prompt recital). */
  | { kind: 'blocked'; verdict: GuardVerdict; firstTokenMs: number | null }
  | { kind: 'failed'; code: ErrorCode; message: string; detail?: string; firstTokenMs: number | null }
  /** The visitor went away. Nothing is stored and nothing is sent. */
  | { kind: 'aborted' };

export interface GenerateInput {
  llm: LLMProvider;
  prompt: BuiltPrompt;
  excerpts: readonly PreparedExcerpt[];
  maxTokens: number;
  temperature: number;
  /** The request's signal: aborted when the connection closes. */
  signal: AbortSignal;
  /** Milliseconds since the request started: for the time to the first token. */
  since: () => number;
  /** Receives the text to stream to the visitor (sentinel withheld, invalid markers dropped). */
  onText: (text: string) => void;
  /** Overrides the process canary (tests). */
  canary?: string;
  /**
   * The visitor's question as typed, and the model's rewrite of it when the rewrite SUCCEEDED (else null): an uncited statement
   * of the document's silence stays in the answer only when it is about these words (silence.ts). Without it, only a gap that
   * names nothing ("The document does not say so.") stays.
   */
  question?: { text: string; rewrite: string | null };
}

export interface GenerateLogger {
  warn(object: object, message: string): void;
}

/**
 * Runs the model on a prompt and applies the reply rules: the not-found sentinel is withheld, markers that do not name
 * an excerpt of this turn are dropped, and the output guard can stop the reply. Never throws except for bugs: every
 * failure is a `Generation` the caller turns into an `error` event.
 */
export async function generateReply(input: GenerateInput, log: GenerateLogger): Promise<Generation> {
  const guard = new OutputGuard(input.prompt.system, input.canary ?? PROCESS_CANARY, GUARD_ALLOWED_PHRASES);
  const valid = new Set(input.excerpts.map((excerpt) => excerpt.id));
  const processor = new ReplyProcessor(valid, guard);
  // The model's own signal is separate so the guard can stop it without pretending the visitor left.
  const stop = new AbortController();
  const onAbort = (): void => stop.abort(input.signal.reason);
  input.signal.addEventListener('abort', onAbort, { once: true });
  let firstTokenMs: number | null = null;
  let finish: { reason: string | null; truncated: boolean } = { reason: null, truncated: false };
  const send = (text: string): void => {
    if (text === '') return;
    firstTokenMs ??= input.since();
    input.onText(text);
  };

  try {
    for await (const chunk of input.llm.stream({
      system: input.prompt.system,
      messages: input.prompt.messages,
      maxTokens: input.maxTokens,
      temperature: input.temperature,
      signal: stop.signal,
      onFinish: (info) => {
        finish = info;
      },
    })) {
      const pushed = processor.push(chunk);
      if (pushed.blocked !== null) {
        stop.abort(new DOMException('The output guard stopped the reply', 'AbortError'));
        return { kind: 'blocked', verdict: pushed.blocked, firstTokenMs };
      }
      send(pushed.emit);
      if (processor.startedWithSentinel) {
        // The model refused (NOT_IN_DOCUMENT): there is nothing more to read, so stop paying for tokens.
        stop.abort(new DOMException('The model refused', 'AbortError'));
        break;
      }
    }
    // A provider that simply stops when it is aborted must not look like a finished reply.
    if (input.signal.aborted) return { kind: 'aborted' };
    send(processor.end());
  } catch (error) {
    if (input.signal.aborted) return { kind: 'aborted' };
    if (error instanceof LlmError) {
      log.warn({ err: error, code: error.code }, 'the language model failed');
      return {
        kind: 'failed',
        code: error.code,
        message: error.message,
        ...(error.detail === undefined ? {} : { detail: error.detail }),
        firstTokenMs,
      };
    }
    if (isAbortError(error)) return { kind: 'aborted' };
    log.warn({ err: error }, 'the answer could not be written');
    return {
      kind: 'failed',
      code: 'LLM_FAILED',
      message: 'The answer could not be written.',
      firstTokenMs,
    };
  } finally {
    input.signal.removeEventListener('abort', onAbort);
  }

  // The guard has seen every chunk as it came (`push`), so the finished text needs no second look.
  if (finish.truncated) log.warn({ finishReason: finish.reason }, 'the reply was cut off');
  return {
    kind: 'ok',
    raw: processor.rawText,
    final: finalizeReply(
      processor.rawText,
      valid,
      input.question === undefined ? null : questionContext(input.question.text, input.question.rewrite),
    ),
    firstTokenMs,
    truncated: finish.truncated,
    finishReason: finish.reason,
  };
}
