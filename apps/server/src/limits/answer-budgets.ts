import type { BudgetKind } from './gemini-budget.js';

/**
 * What a route spends of the Gemini daily budgets: an answer is one request of the answer model's quota and the question
 * one text of the embedding quota; a reveal is one request of the answer model. The small calls around an answer, the rewrite
 * and the grounding check, are on the auxiliary model (the `aux` kind): they are reserved where they are made, one at a time.
 *
 * The routes take these budgets themselves, in `rag/spend.ts`, AFTER the question was accepted (the document is the session's
 * and ready, the body is valid, no other answer of the session is in flight) and give back what was not spent (a question the
 * evidence gate stopped made no model call). A refused or invalid question therefore costs nothing.
 */
export const ANSWER_SPENDING = {
  ask: ['llm', 'embed'],
  reveal: ['llm'],
} as const satisfies Record<string, readonly BudgetKind[]>;
