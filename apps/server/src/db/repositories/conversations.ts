import { randomUUID } from 'node:crypto';
import type { AnswerMode, Citation, Message, RefusedBy } from '@enchanted/shared';
import type { Queryable } from '../client.js';

export type MessageRole = 'user' | 'assistant';
export type MessageKind = 'question' | 'answer' | 'reveal';

/** What was retrieved and how, stored with an assistant message (the `retrieval` jsonb column). */
export interface RetrievalRecord {
  promptVersion: string;
  query: string;
  rewrittenQuery: string | null;
  evidence: 'strong' | 'weak' | 'none';
  searchedChunks: number;
  retrievedChunks: number;
  pages: number[];
  timingsMs: Record<string, number | null>;
  llm: { provider: string; model: string; auxModel?: string } | null;
  /** The grounding check's verdict (`skipped`: it did not run, failed or timed out, which lets the answer through). */
  grounding?: 'yes' | 'no' | 'skipped' | null;
  /** Why the grounding check was skipped: `timeout`, `error`, `empty`; with the error's code in `groundingError`. */
  groundingReason?: string | null;
  groundingError?: string | null;
  /** How the follow-up was made searchable: by the model, by the fallback join, or not at all (a first question). */
  rewriteSource?: 'llm' | 'heuristic' | null;
  rewriteReason?: string | null;
  /** The question was about the document as a whole and was answered from the manuscript overview. */
  meta?: boolean;
  /** The query could not be embedded: the chunks come from words and pages alone. */
  degraded?: boolean;
  chunks: {
    marker: string;
    chunkId: string;
    page: number;
    semanticRank: number | null;
    lexicalRank: number | null;
    pageRank: number | null;
    rrfScore: number;
    flagged: boolean;
  }[];
}

/** Safety facts about a message (the `flags` jsonb column). */
export interface MessageFlags {
  /** For a not-found answer: which guard refused (evidence gate, grounding check, or the model's own refusal). */
  refusedBy?: RefusedBy;
  /** The output guard replaced the model's text (canary or system prompt echo). */
  outputBlocked?: boolean;
  guardReason?: string;
  /** Ids of retrieved chunks that look like they try to give orders. */
  injectionFlaggedChunks?: string[];
  /** The reply was cut off (the output limit, or a filter that stopped it after some text). */
  truncated?: boolean;
  /** The provider's own stop reason, when it gave one. */
  finishReason?: string;
  /** Lines of the reply that were dropped because they cited nothing. */
  uncitedLinesDropped?: number;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: MessageRole;
  kind: MessageKind;
  content: string;
  mode: AnswerMode | null;
  grounded: boolean | null;
  citations: Citation[];
  retrieval: RetrievalRecord | null;
  flags: MessageFlags;
  created_at: Date;
}

export interface NewMessage {
  role: MessageRole;
  kind: MessageKind;
  content: string;
  mode?: AnswerMode;
  grounded?: boolean;
  citations?: Citation[];
  retrieval?: RetrievalRecord;
  flags?: MessageFlags;
}

const COLUMNS =
  'id, conversation_id, role, kind, content, mode, grounded, citations, retrieval, flags, created_at';

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    role: row.role,
    kind: row.kind,
    content: row.content,
    ...(row.mode === null ? {} : { mode: row.mode }),
    ...(row.grounded === null ? {} : { grounded: row.grounded }),
    ...(row.mode === 'not_found' ? { refusedBy: row.flags.refusedBy ?? null } : {}),
    ...(row.flags.truncated === true ? { truncated: true } : {}),
    citations: row.citations,
    createdAt: (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)).toISOString(),
  };
}

export const conversationsRepo = {
  /** The conversation of a document, created on first use (one per document). */
  async ensure(q: Queryable, documentId: string): Promise<string> {
    const result = await q.query<{ id: string }>(
      `INSERT INTO conversations (id, document_id) VALUES ($1, $2)
       ON CONFLICT (document_id) DO UPDATE SET document_id = EXCLUDED.document_id
       RETURNING id`,
      [randomUUID(), documentId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('INSERT INTO conversations returned no row');
    return row.id;
  },

  async find(q: Queryable, documentId: string): Promise<string | null> {
    const result = await q.query<{ id: string }>('SELECT id FROM conversations WHERE document_id = $1', [
      documentId,
    ]);
    return result.rows[0]?.id ?? null;
  },

  async addMessage(q: Queryable, conversationId: string, message: NewMessage): Promise<MessageRow> {
    const result = await q.query<MessageRow>(
      `INSERT INTO messages (id, conversation_id, role, kind, content, mode, grounded, citations, retrieval, flags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb)
       RETURNING ${COLUMNS}`,
      [
        randomUUID(),
        conversationId,
        message.role,
        message.kind,
        message.content,
        message.mode ?? null,
        message.grounded ?? null,
        JSON.stringify(message.citations ?? []),
        message.retrieval === undefined ? null : JSON.stringify(message.retrieval),
        JSON.stringify(message.flags ?? {}),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('INSERT INTO messages returned no row');
    return row;
  },

  /** Every message of the conversation, oldest first. */
  async list(q: Queryable, conversationId: string): Promise<MessageRow[]> {
    const result = await q.query<MessageRow>(
      `SELECT ${COLUMNS} FROM messages WHERE conversation_id = $1 ORDER BY created_at, id`,
      [conversationId],
    );
    return result.rows;
  },

  /** The newest `limit` messages of the given kinds, oldest first. */
  async recent(
    q: Queryable,
    conversationId: string,
    limit: number,
    kinds: readonly MessageKind[],
  ): Promise<MessageRow[]> {
    const result = await q.query<MessageRow>(
      `SELECT ${COLUMNS} FROM (
         SELECT ${COLUMNS} FROM messages WHERE conversation_id = $1 AND kind = ANY($2::text[])
         ORDER BY created_at DESC, id DESC LIMIT $3) newest
       ORDER BY created_at, id`,
      [conversationId, [...kinds], limit],
    );
    return result.rows;
  },

  /** The latest answer that cited the document, with the question that preceded it (null when there is none). */
  async latestGroundedAnswer(
    q: Queryable,
    conversationId: string,
  ): Promise<{ answer: MessageRow; question: string | null } | null> {
    const answers = await q.query<MessageRow>(
      `SELECT ${COLUMNS} FROM messages
       WHERE conversation_id = $1 AND role = 'assistant' AND kind = 'answer' AND grounded = true
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [conversationId],
    );
    const answer = answers.rows[0];
    if (answer === undefined) return null;
    const questions = await q.query<{ content: string }>(
      `SELECT content FROM messages
       WHERE conversation_id = $1 AND role = 'user' AND kind = 'question' AND created_at <= $2
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [conversationId, answer.created_at],
    );
    return { answer, question: questions.rows[0]?.content ?? null };
  },

  /** Clears the conversation of a document (its messages); the document itself stays. */
  async clear(q: Queryable, documentId: string): Promise<void> {
    await q.query(
      'DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE document_id = $1)',
      [documentId],
    );
  },
};
