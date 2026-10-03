import type { Citation } from '@enchanted/shared';
import type { MessageRow } from '../db/repositories/conversations.js';
import type { LlmMessage } from '../llm/provider.js';
import { alternateTurns } from './prompts.js';
import { HISTORY_MAX_CHARS, MARKER_SOURCE } from './constants.js';
import { sanitizeExcerptText } from './injection.js';
import { SENTINEL_TOKENS } from './sentinel.js';

/** `(p. 3)` or `(pp. 3-4)`: what an excerpt marker of an earlier answer turns into. */
function pageNote(citation: Citation): string {
  return citation.pageEnd > citation.pageStart
    ? `(pp. ${String(citation.pageStart)}-${String(citation.pageEnd)})`
    : `(p. ${String(citation.pageStart)})`;
}

/**
 * An earlier answer as the next prompt sees it. Excerpt ids are valid for one turn only, so every `[S#]` is
 * replaced by the page it cited (`(p. 3)`), or removed when it cited nothing real; the refusal sentinel goes too.
 * The excerpts themselves are never part of history.
 */
export function historyText(content: string, citations: readonly Citation[]): string {
  const pages = new Map(citations.map((citation) => [citation.marker, pageNote(citation)]));
  const replaced = content
    .replace(SENTINEL_TOKENS, '')
    .replace(new RegExp(MARKER_SOURCE, 'gu'), (_match, digits: string) => pages.get(`S${digits}`) ?? '');
  // The same page cited twice in a row is said once.
  return replaced
    .replace(/(\(pp?\. [\d-]+\))(?:\s*\1)+/gu, '$1')
    .replace(/[ \t]{2,}/gu, ' ')
    .trim();
}

export interface HistoryOptions {
  /** RAG_HISTORY_MESSAGES. */
  maxMessages: number;
  maxChars?: number;
}

/**
 * The conversation as prompt turns: the newest `maxMessages` questions and answers (reveals are not conversation),
 * assistant turns without excerpts and without excerpt ids, the visitor's and the diary's text sanitised like any
 * other text that could carry structure, at most `maxChars` characters in total (the oldest turn is cut first).
 */
export function buildHistory(rows: readonly MessageRow[], options: HistoryOptions): LlmMessage[] {
  if (options.maxMessages <= 0) return [];
  const maxChars = options.maxChars ?? HISTORY_MAX_CHARS;
  const turns: LlmMessage[] = rows
    .filter((row) => row.kind !== 'reveal')
    .slice(-options.maxMessages)
    .map((row) => ({
      role: row.role,
      content: sanitizeExcerptText(
        row.role === 'assistant' ? historyText(row.content, row.citations) : row.content,
      ),
    }));

  // Keep the newest turns that fit; the one that crosses the limit is cut at its end (its beginning is the context).
  const kept: LlmMessage[] = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn === undefined) continue;
    const remaining = maxChars - used;
    if (remaining <= 0) break;
    const content = turn.content.length > remaining ? turn.content.slice(0, remaining) : turn.content;
    kept.unshift({ role: turn.role, content });
    used += content.length;
  }
  return alternateTurns(kept);
}
