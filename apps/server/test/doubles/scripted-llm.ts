import type { LLMProvider, LlmMessage, LlmRequest } from '../../src/llm/provider.js';
import { LlmError } from '../../src/llm/provider.js';
import { NOT_IN_DOCUMENT } from '../../src/rag/constants.js';
import { arabicRatio, detectQuestionLanguage } from '../../src/rag/language.js';
import { GROUNDING_SYSTEM_PROMPT, REWRITE_SYSTEM_PROMPT } from '../../src/rag/prompts.js';

/*
 * A language model that plays a script: for tests and for the deterministic end-to-end server. It records every
 * request it receives (system prompt, messages, limits) so a test can assert what the model was shown, and it replies
 * with the first rule that matches (or a default that quotes the excerpts). Test code only: nothing in `src/` may
 * import this file.
 */

export type CallKind = 'answer' | 'rewrite' | 'reveal' | 'grounding';

export interface LlmCall {
  kind: CallKind;
  system: string;
  messages: LlmMessage[];
  maxTokens: number;
  temperature: number;
  /** `auxiliary` for the rewrite and the grounding check. */
  tier: 'primary' | 'auxiliary';
  /** The deadline the caller asked for (`LlmRequest.timeoutMs`), when it did. */
  timeoutMs: number | undefined;
  /** The text of the last user turn. */
  lastUser: string;
  /** Set when the request's signal aborted while the reply was still being played. */
  aborted: boolean;
  /** Set when the whole script was played. */
  completed: boolean;
}

export type Reply = string | readonly string[] | AsyncIterable<string>;

export interface ScriptRule {
  when: (call: LlmCall) => boolean;
  reply: Reply | ((call: LlmCall, signal: AbortSignal | undefined) => Reply);
  /** Milliseconds between chunks. */
  delayMs?: number;
  /** How the reply ended, reported through `onFinish` once it is complete (the output limit, a filter). */
  finish?: { reason: string; truncated: boolean };
}

export interface ScriptedOptions {
  /** `isConfigured()`; false makes the pipeline show passages instead of calling the model. */
  configured?: boolean;
  /** A default reply is split into chunks of this many characters (a model streams pieces, not whole answers). */
  chunkChars?: number;
  /** Replaces the default behaviour for requests no rule matches. */
  fallback?: (call: LlmCall) => Reply;
}

const EXCERPT = /<excerpt id="(S\d+)"[^>]*>\n([\s\S]*?)\n<\/excerpt>/gu;

/** The excerpts a request showed the model: `[{ id: 'S1', text }]`. */
export function excerptsOf(call: Pick<LlmCall, 'lastUser'>): { id: string; text: string }[] {
  return Array.from(call.lastUser.matchAll(EXCERPT), (match) => ({
    id: match[1] ?? '',
    text: match[2] ?? '',
  }));
}

/** The first sentence of a text (up to . ? ! or their CJK / Arabic forms), at most 200 characters. */
export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  const end = flat.search(/[.!?。؟](?:\s|$)/u);
  const sentence = end === -1 ? flat : flat.slice(0, end + 1);
  return sentence.length > 200 ? `${sentence.slice(0, 197)}...` : sentence;
}

const TAGGED_QUESTION = /<question>\n([\s\S]*?)\n<\/question>/u;
/** `Question: ...` / `السؤال: ...` of the answer and grounding templates (the LAST one: excerpt text may hold the word). */
const LABELLED_QUESTION =
  /^(?:Question|السؤال):[ \t]*([\s\S]*?)\n(?:\n(?:Do the excerpts|هل تحتوي)[^\n]*|(?:Answer in [^\n]*:|الإجابة بالعربية:)[ \t]*)$/gmu;

/** The question a request asked, whichever template carried it (answer, grounding check, rewrite or reveal). */
export function questionIn(lastUser: string): string {
  const labelled = [...lastUser.matchAll(LABELLED_QUESTION)].at(-1)?.[1];
  if (labelled !== undefined) return labelled.trim();
  return TAGGED_QUESTION.exec(lastUser)?.[1]?.trim() ?? '';
}

const questionOf = (call: LlmCall): string => questionIn(call.lastUser);

/**
 * What the double frames the sentence it quotes with, by the language it writes in. Arabic is Arabic all through (global §T.2: no
 * English in the Arabic experience, the scripted server of the QA shots included); every other language gets English, the
 * double's own.
 */
const FRAMES = {
  en: { answer: 'The document states:', memory: 'Memory:', open: '"', close: '"' },
  ar: { answer: 'يذكر المستند:', memory: 'أتذكّر:', open: '«', close: '»' },
} as const;

/**
 * The language a call asks its reply in: a reveal names it ("Write in Arabic."), or says to follow the excerpts (then the first
 * excerpt's script decides); an answer is in the language of its question.
 */
export function replyLanguage(call: Pick<LlmCall, 'lastUser'>): 'ar' | 'en' {
  const named = /(?:^|\n)Write in ([A-Za-z]+)\./u.exec(call.lastUser)?.[1];
  if (named !== undefined && named !== 'the') return named === 'Arabic' ? 'ar' : 'en';
  const question = questionIn(call.lastUser);
  if (question !== '') return detectQuestionLanguage(question) === 'ar' ? 'ar' : 'en';
  const first = excerptsOf(call)[0];
  return first !== undefined && arabicRatio(first.text) >= 0.5 ? 'ar' : 'en';
}

/** What the double says when no rule matches: a quote of the first excerpt it was shown, cited by its id, framed in the reply's language. */
export function defaultReply(call: LlmCall): string {
  if (call.kind === 'rewrite') return questionOf(call);
  if (call.kind === 'grounding') return 'yes';
  const excerpts = excerptsOf(call);
  const first = excerpts[0];
  if (first === undefined) return NOT_IN_DOCUMENT;
  const frame = FRAMES[replyLanguage(call)];
  const quote = (text: string): string => `${frame.open}${firstSentence(text)}${frame.close}`;
  if (call.kind === 'reveal') {
    const points = excerpts.slice(0, 4).map((excerpt) => `- ${firstSentence(excerpt.text)} [${excerpt.id}]`);
    return `${frame.memory} ${quote(first.text)} [${first.id}]\n${points.join('\n')}`;
  }
  return `${frame.answer} ${quote(first.text)} [${first.id}]`;
}

const kindOf = (system: string): CallKind => {
  if (system.startsWith(REWRITE_SYSTEM_PROMPT.slice(0, 40))) return 'rewrite';
  if (system.startsWith(GROUNDING_SYSTEM_PROMPT.slice(0, 40))) return 'grounding';
  return system.startsWith('You are the memory of') ? 'reveal' : 'answer';
};

function* split(text: string, size: number): Generator<string> {
  for (let index = 0; index < text.length; index += size) yield text.slice(index, index + size);
}

const wait = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export class ScriptedLlm implements LLMProvider {
  readonly name = 'scripted';
  readonly model = 'scripted-1';
  readonly calls: LlmCall[] = [];
  private readonly rules: ScriptRule[];
  private readonly options: ScriptedOptions;

  constructor(rules: readonly ScriptRule[] = [], options: ScriptedOptions = {}) {
    this.rules = [...rules];
    this.options = options;
  }

  isConfigured(): boolean {
    return this.options.configured ?? true;
  }

  /** The calls of one kind, in order. */
  callsOf(kind: CallKind): LlmCall[] {
    return this.calls.filter((call) => call.kind === kind);
  }

  async *stream(request: LlmRequest): AsyncGenerator<string> {
    const last = request.messages.at(-1);
    const call: LlmCall = {
      kind: kindOf(request.system),
      system: request.system,
      messages: request.messages.map((message) => ({ ...message })),
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      tier: request.tier ?? 'primary',
      timeoutMs: request.timeoutMs,
      lastUser: last?.role === 'user' ? last.content : '',
      aborted: false,
      completed: false,
    };
    this.calls.push(call);
    const onAbort = (): void => {
      call.aborted = true;
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const rule = this.rules.find((candidate) => candidate.when(call));
      const reply =
        rule === undefined
          ? (this.options.fallback?.(call) ?? defaultReply(call))
          : typeof rule.reply === 'function'
            ? rule.reply(call, request.signal)
            : rule.reply;
      const delay = rule?.delayMs ?? 0;
      const chunks: AsyncIterable<string> | Iterable<string> =
        typeof reply === 'string' ? split(reply, this.options.chunkChars ?? 24) : reply;
      for await (const chunk of chunks) {
        if (request.signal?.aborted === true) {
          call.aborted = true;
          throw request.signal.reason instanceof Error
            ? request.signal.reason
            : new DOMException('Aborted', 'AbortError');
        }
        if (delay > 0) await wait(delay, request.signal);
        yield chunk;
      }
      call.completed = true;
      request.onFinish?.(rule?.finish ?? { reason: 'STOP', truncated: false });
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
    }
  }
}

/** A reply that waits until the request is aborted (to prove that an abort reaches the provider). */
export async function* untilAborted(signal: AbortSignal | undefined, first = 'The '): AsyncGenerator<string> {
  yield first;
  await new Promise<void>((resolve) => {
    if (signal?.aborted === true) resolve();
    signal?.addEventListener('abort', () => resolve(), { once: true });
  });
  // a provider's stream rejects with an AbortError when its request is aborted
  throw signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}

/** A reply that fails the way a hosted provider does (after `before`, if given). */
export function failing(
  code: 'LLM_FAILED' | 'LLM_UNAVAILABLE' | 'RATE_LIMITED',
  message: string,
  before = '',
  detail?: string,
): () => AsyncIterable<string> {
  return async function* (): AsyncGenerator<string> {
    await Promise.resolve();
    if (before !== '') yield before;
    throw new LlmError(code, message, detail === undefined ? {} : { detail });
  };
}
