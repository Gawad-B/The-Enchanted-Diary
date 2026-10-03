import type { AnswerStreamEvent, DocumentDetail } from '@enchanted/shared';
import { AnswerStreamEventSchema } from '@enchanted/shared';
import { chunksRepo, type ChunkRecord } from '../src/db/repositories/chunks.js';
import { documentsRepo } from '../src/db/repositories/documents.js';
import { embeddingsRepo } from '../src/db/repositories/embeddings.js';
import type { Db } from '../src/db/client.js';
import type { LLMProvider } from '../src/llm/provider.js';
import type { Config } from '../src/config.js';
import type { RagDeps } from '../src/rag/answer.js';
import { normalizeForSearch } from '@enchanted/shared';
import { FakeEmbeddings, hashedVector } from './doubles/fake-embeddings.js';
import { STAND_IN_THRESHOLDS } from './doubles/stand-in-thresholds.js';
import { insertSession, testConfig } from './helpers.js';
import { startServer, summaryOf, waitForDocument, type Client, type TestServer } from './http-helpers.js';

/** Uploads a fixture as a fresh client (its own session) and waits until it is ready. */
export async function ingestFixture(
  server: TestServer,
  name: string,
  timeoutMs = 120_000,
): Promise<{ client: Client; document: DocumentDetail }> {
  const client = server.client();
  const document = await waitForDocument(client, summaryOf(await client.uploadFixture(name)).id, timeoutMs);
  if (document.status !== 'ready')
    throw new Error(`${name} did not become ready: ${document.error?.message ?? ''}`);
  return { client, document };
}

/** The events of an ask or reveal, collected from `emit`, validated against the contract. */
export function collector(): { events: AnswerStreamEvent[]; emit(event: AnswerStreamEvent): void } {
  const events: AnswerStreamEvent[] = [];
  return {
    events,
    emit: (event) => {
      events.push(AnswerStreamEventSchema.parse(event));
    },
  };
}

export function eventOf<T extends AnswerStreamEvent['type']>(
  events: readonly AnswerStreamEvent[],
  type: T,
): Extract<AnswerStreamEvent, { type: T }> {
  const found = events.find((event): event is Extract<AnswerStreamEvent, { type: T }> => event.type === type);
  if (found === undefined)
    throw new Error(`no ${type} event in [${events.map((event) => event.type).join(', ')}]`);
  return found;
}

export const tokensOf = (events: readonly AnswerStreamEvent[]): string =>
  events.map((event) => (event.type === 'token' ? event.text : '')).join('');

export { STAND_IN_THRESHOLDS, STRICT_THRESHOLDS } from './doubles/stand-in-thresholds.js';

/** RagDeps around a database and the stand-in embedding model. */
export function ragDeps(
  db: Db,
  llm: LLMProvider,
  // The grounding check is off by default: most tests want the answer model to be the only call (tests of the check turn it on).
  config: Config = testConfig({ RAG_GROUNDING_CHECK: 'false' }),
  extra: Partial<RagDeps> = {},
): RagDeps {
  return {
    db,
    config,
    embeddings: new FakeEmbeddings(),
    llm,
    log: { warn: () => undefined, error: () => undefined },
    // The stand-in model's cosine scores are not Gemini's: it has its own thresholds.
    evidence: STAND_IN_THRESHOLDS,
    ...extra,
  };
}

export interface SyntheticChunk {
  page: number;
  text: string;
  section?: string | null;
  language?: string;
}

/**
 * A ready document made of the given chunks, written straight into the database (no PDF, no worker thread): the
 * chunk texts are indexed like ingestion would (`search_text` from the shared normaliser) and embedded with the
 * stand-in model. For tests that need a document of an exact shape.
 */
export async function insertSyntheticDocument(
  db: Db,
  chunks: readonly SyntheticChunk[],
  options: {
    filename?: string;
    pageCount?: number;
    /** The embedding model: its id, and how it embeds passages (default: the stand-in hashed vectors). */
    embedder?: { model: string; embedPassages(texts: readonly string[]): Promise<number[][]> };
    primaryLanguage?: string;
    direction?: 'ltr' | 'rtl';
  } = {},
): Promise<{ documentId: string; sessionId: string; chunkIds: string[] }> {
  const sessionId = await insertSession(db);
  const documentId = crypto.randomUUID();
  const pageCount = options.pageCount ?? Math.max(1, ...chunks.map((chunk) => chunk.page));
  await documentsRepo.insert(db, {
    id: documentId,
    sessionId,
    filename: options.filename ?? 'synthetic.pdf',
    byteSize: 1,
    sha256: 'x'.repeat(64),
    pageCount,
    storageKey: `${documentId}.pdf`,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  await documentsRepo.markReady(db, documentId, {
    primaryLanguage: options.primaryLanguage ?? 'en',
    direction: options.direction ?? 'ltr',
    languages: [{ code: options.primaryLanguage ?? 'en', share: 1 }],
    sections: [],
    warnings: [],
    pageCount,
  });
  const records: ChunkRecord[] = chunks.map((chunk, index) => ({
    id: crypto.randomUUID(),
    chunkIndex: index,
    pageStart: chunk.page,
    pageEnd: chunk.page,
    sectionTitle: chunk.section ?? null,
    language: chunk.language ?? 'en',
    direction: options.direction ?? 'ltr',
    content: chunk.text,
    searchText: normalizeForSearch(chunk.text),
    charStart: 0,
    charEnd: chunk.text.length,
    overlapChars: 0,
    tokenCount: Math.ceil(chunk.text.length / 4),
    highlights: [
      {
        page: chunk.page,
        rects: [{ x: 0.1, y: 0.1, w: 0.8, h: 0.05 }],
        charStart: 0,
        charEnd: chunk.text.length,
      },
    ],
  }));
  await chunksRepo.insertMany(db, documentId, records);
  const embedder = options.embedder ?? {
    model: 'fake-hash-384',
    embedPassages: (texts: readonly string[]) => Promise.resolve(texts.map(hashedVector)),
  };
  const vectors = await embedder.embedPassages(records.map((record) => record.content));
  await embeddingsRepo.insertMany(
    db,
    records.map((record, index) => ({
      chunkId: record.id,
      model: embedder.model,
      embedding: vectors[index] ?? [],
    })),
  );
  return { documentId, sessionId, chunkIds: records.map((record) => record.id) };
}

/** Reads an ask / reveal event stream (fetch) until it ends: the events (validated) and the `: hb` comment frames. */
export async function readAnswerSse(
  response: Response,
  options: { stop?: (event: AnswerStreamEvent) => boolean } = {},
): Promise<{ events: AnswerStreamEvent[]; comments: string[]; ended: boolean }> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('no body');
  const decoder = new TextDecoder();
  const events: AnswerStreamEvent[] = [];
  const comments: string[] = [];
  let buffer = '';
  let ended = false;
  let stopped = false;
  while (!stopped) {
    const chunk = await reader.read();
    if (chunk.done) {
      ended = true;
      break;
    }
    buffer += decoder.decode(chunk.value as Uint8Array, { stream: true });
    let separator = buffer.indexOf('\n\n');
    while (separator !== -1) {
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      if (frame.startsWith(':')) comments.push(frame.slice(1).trim());
      else if (frame.startsWith('data: ')) {
        const event = AnswerStreamEventSchema.parse(JSON.parse(frame.slice(6)));
        events.push(event);
        if (options.stop?.(event) === true) stopped = true;
      }
      separator = buffer.indexOf('\n\n');
    }
  }
  await reader.cancel().catch(() => undefined);
  return { events, comments, ended };
}

export { startServer };
