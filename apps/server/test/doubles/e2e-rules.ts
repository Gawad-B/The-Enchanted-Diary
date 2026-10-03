import { NOT_IN_DOCUMENT } from '../../src/rag/constants.js';
import { defaultReply, questionIn, type ScriptRule } from './scripted-llm.js';

/*
 * The scripted behaviour of the deterministic end-to-end server (see test/e2e-server.ts): rules on top of the
 * double's default, which quotes the first sentence of the first excerpt it was shown and cites its id. Test code only.
 */

/** Questions (any language) for which the scripted grounding check says the excerpts do not hold the answer. */
export const UNGROUNDED_QUESTIONS: readonly RegExp[] = [/football/iu, /كرة القدم/u];

/** Questions (any language) for which the scripted model itself replies NOT_IN_DOCUMENT. */
export const NOT_FOUND_QUESTIONS: readonly RegExp[] = [
  /favou?rite colou?r/iu,
  /capital of peru/iu,
  /اللون المفضل/u,
];

const isSlow = (lastUser: string): boolean => /\[slow\]/iu.test(questionIn(lastUser));

export const E2E_RULES: ScriptRule[] = [
  // Guard 2: a question the grounding check says the excerpts cannot answer (a topic that shares words with the document).
  {
    when: (call) =>
      call.kind === 'grounding' &&
      UNGROUNDED_QUESTIONS.some((pattern) => pattern.test(questionIn(call.lastUser))),
    reply: 'no',
  },
  // Guard 3: the model's own refusal.
  {
    when: (call) =>
      call.kind === 'answer' &&
      NOT_FOUND_QUESTIONS.some((pattern) => pattern.test(questionIn(call.lastUser))),
    reply: NOT_IN_DOCUMENT,
  },
  // The default answer, written slowly: a journey can look at the stream while it is running.
  { when: (call) => call.kind === 'answer' && isSlow(call.lastUser), reply: defaultReply, delayMs: 150 },
];
