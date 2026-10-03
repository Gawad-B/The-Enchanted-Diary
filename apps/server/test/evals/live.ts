import { mkdir, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { AnswerStreamEvent, Citation, DocumentDetail } from '@enchanted/shared';
import { REPO_ROOT, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db/client.js';
import { GeminiEmbeddings } from '../../src/embeddings/gemini.js';
import type { EmbeddingProvider } from '../../src/embeddings/provider.js';
import { getGeminiClient, type GeminiClient } from '../../src/gemini/index.js';
import { loadConfigFromEnvironment } from '../../src/env-file.js';
import { evidenceThresholdsFor, type EvidenceThresholds } from '../../src/rag/constants.js';
import { GeminiLlmProvider } from '../../src/llm/gemini.js';
import type { LLMProvider, LlmRequest } from '../../src/llm/provider.js';
import { TEST_ROOT, nextTestDirectory } from '../helpers.js';
import { startServer, type Client, type TestServer } from '../http-helpers.js';
import { ingestFixture, readAnswerSse } from '../rag-helpers.js';

/*
 * Support for the live evals (npm run test:evals): the whole server in this process, on an in-memory database, talking to
 * the REAL Gemini API with the key of the git-ignored .env (it is read by the server's own configuration loader and is
 * never printed). Nothing here runs unless RUN_LLM_EVALS=1 and a key is configured. Every request to Gemini goes through
 * a counter, so a run states how many calls it made and cannot run away (the free tier is a daily quota).
 */

export const TASK_DATA = path.join(REPO_ROOT, '.data', 'task4');

/** The configuration of a live run, or null when the evals are not enabled or there is no Gemini key. */
export function liveConfig(): Config | null {
  if (process.env.RUN_LLM_EVALS !== '1') return null;
  let config: Config;
  try {
    config = loadConfigFromEnvironment();
  } catch {
    return null;
  }
  if (
    config.llmProvider !== 'gemini' ||
    config.embeddingProvider !== 'gemini' ||
    config.geminiApiKey === null
  ) {
    return null;
  }
  return {
    ...config,
    nodeEnv: 'test',
    logLevel: 'silent',
    pgliteDataDir: 'memory://',
    storageDir: nextTestDirectory('storage'),
    tmpDir: nextTestDirectory('tmp'),
    // Scanned pages are not part of these evals (and each one would be a Gemini call).
    ocrProvider: 'none',
    rateLimitPerMinute: 100_000,
    uploadsPerHour: 100_000,
    uploadsPerHourPerIp: 100_000,
    questionsPerMinute: 100_000,
    // Stay under the free tier's requests per minute (about 15 for the lite models).
    geminiMaxRpm: Number(process.env.GEMINI_MAX_RPM ?? '12'),
  };
}

export interface CallCounts {
  /** Answer-model requests (the answers, the reveal). */
  answer: number;
  /** Auxiliary-model requests (the follow-up rewrite, the grounding check). */
  auxiliary: number;
  /** Embedding requests (one per batch of chunks, one per question). */
  embeddingRequests: number;
  /** Texts embedded (what the daily embedding quota counts). */
  embeddingTexts: number;
}

/** Counts, and caps, what the run asks of Gemini. */
export class Budget {
  readonly counts: CallCounts = { answer: 0, auxiliary: 0, embeddingRequests: 0, embeddingTexts: 0 };

  constructor(readonly maxRequests: number) {}

  get total(): number {
    return this.counts.answer + this.counts.auxiliary + this.counts.embeddingRequests;
  }

  spend(kind: 'answer' | 'auxiliary' | 'embedding', texts = 0): void {
    if (this.total >= this.maxRequests) {
      throw new Error(`the live eval budget of ${String(this.maxRequests)} Gemini requests is used up`);
    }
    if (kind === 'embedding') {
      this.counts.embeddingRequests += 1;
      this.counts.embeddingTexts += texts;
    } else this.counts[kind] += 1;
  }
}

/** What the model said, call by call (the raw text, before the pipeline cleaned it): for the table of a run. */
export interface ModelReply {
  tier: 'primary' | 'auxiliary';
  text: string;
}

/** Records what the model said, call by call (the provider is the real one: the counting is done at the SDK client below). */
class RecordingLlm implements LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly handlesTimeout?: boolean | undefined;

  constructor(
    private readonly inner: LLMProvider,
    private readonly transcript: ModelReply[],
  ) {
    this.name = inner.name;
    this.model = inner.model;
    this.handlesTimeout = inner.handlesTimeout;
  }

  isConfigured(): boolean {
    return this.inner.isConfigured();
  }

  async *stream(request: LlmRequest): AsyncGenerator<string> {
    const reply: ModelReply = { tier: request.tier ?? 'primary', text: '' };
    this.transcript.push(reply);
    for await (const piece of this.inner.stream(request)) {
      reply.text += piece;
      yield piece;
    }
  }
}

/**
 * The real SDK client, with every HTTP request it sends counted: a thinking-ladder attempt and a retry are requests too, which
 * counting calls of the provider would miss. `auxiliaryModel` tells the small calls from the answers.
 */
function countingClient(
  budget: Budget,
  auxiliaryModel: string,
  config: Config,
): GeminiClient<'generateContent' | 'generateContentStream' | 'embedContent'> {
  const real = getGeminiClient(config);
  return {
    models: {
      generateContent: real.models.generateContent.bind(real.models),
      generateContentStream: (params) => {
        budget.spend(params.model === auxiliaryModel ? 'auxiliary' : 'answer');
        return real.models.generateContentStream(params);
      },
      embedContent: (params) => {
        const contents = params.contents;
        budget.spend('embedding', Array.isArray(contents) ? contents.length : 1);
        return real.models.embedContent(params);
      },
    },
  };
}

/**
 * Embeds a question once: the same text asked again (a sampled row, the three channels of the benchmark) is served from memory
 * and costs no request. `prime` embeds many questions in ONE request (the calibration's few dozen).
 */
export class CachingEmbeddings implements EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number | null;
  readonly maxInputTokens: number;
  private readonly cache = new Map<string, number[]>();

  constructor(private readonly inner: GeminiEmbeddings) {
    this.name = inner.name;
    this.model = inner.model;
    this.dimensions = inner.dimensions;
    this.maxInputTokens = inner.maxInputTokens;
  }

  embedPassages(
    texts: readonly string[],
    signal?: AbortSignal,
    options?: Parameters<EmbeddingProvider['embedPassages']>[2],
  ): Promise<number[][]> {
    return this.inner.embedPassages(texts, signal, options);
  }

  async prime(texts: readonly string[]): Promise<void> {
    const missing = [...new Set(texts)].filter((text) => !this.cache.has(text));
    if (missing.length === 0) return;
    const vectors = await this.inner.embedQueries(missing);
    missing.forEach((text, index) => {
      const vector = vectors[index];
      if (vector !== undefined) this.cache.set(text, vector);
    });
  }

  async embedQuery(text: string, signal?: AbortSignal): Promise<number[]> {
    const known = this.cache.get(text);
    if (known !== undefined) return known;
    const vector = await this.inner.embedQuery(text, signal);
    this.cache.set(text, vector);
    return vector;
  }
}

export interface Live {
  db: Db;
  server: TestServer;
  config: Config;
  origin: string;
  budget: Budget;
  /** Every reply of the models so far, raw, in order. */
  transcript: ModelReply[];
  embeddings: CachingEmbeddings;
  /** The real answer model, as the pipeline calls it (counted). */
  llm: LLMProvider;
  /** The evidence thresholds the server reads on every question (a copy of the calibrated ones, which a row may force). */
  thresholds: EvidenceThresholds;
  /** Forces the evidence label to read WEAK (the strong marks above any cosine; the floors are untouched), or restores the calibrated marks. */
  forceWeak(on: boolean): void;
  /** Uploads a fixture as a fresh session and waits until it is ready (the chunks are embedded with Gemini). */
  ingest(name: string): Promise<{ client: Client; document: DocumentDetail }>;
  ask(client: Client, documentId: string, question: string): Promise<Asked>;
  reveal(client: Client, documentId: string, focus: 'answer' | 'manuscript'): Promise<Asked>;
  close(): Promise<void>;
}

export interface Asked {
  events: AnswerStreamEvent[];
  elapsedMs: number;
}

export async function startLive(config: Config, maxRequests: number): Promise<Live> {
  const budget = new Budget(maxRequests);
  const db = await createDb(config);
  const client = countingClient(budget, config.llmAuxModel, config);
  const embeddings = new CachingEmbeddings(
    new GeminiEmbeddings({
      apiKey: config.geminiApiKey,
      model: config.embeddingModel,
      dimensions: config.embeddingDimensions,
      batchSize: config.embeddingBatchSize,
      client,
    }),
  );
  const transcript: ModelReply[] = [];
  const llm = new RecordingLlm(
    new GeminiLlmProvider({
      apiKey: config.geminiApiKey,
      model: config.llmModel,
      auxModel: config.llmAuxModel,
      maxRpm: config.geminiMaxRpm,
      client,
    }),
    transcript,
  );
  // (a copy: the server keeps this very object and reads its fields on every question, so a row can force the evidence to weak)
  const calibrated = evidenceThresholdsFor(config.embeddingModel);
  const thresholds: EvidenceThresholds = { ...calibrated };
  const server = await startServer(db, config, { embeddings, deps: { llm, rag: { evidence: thresholds } } });
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${String((server.app.server.address() as AddressInfo).port)}`;

  const post = async (client: Client, route: string, body: unknown): Promise<Asked> => {
    const started = Date.now();
    const response = await fetch(`${origin}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...client.cookieHeader() },
      body: JSON.stringify(body),
    });
    const { events } = await readAnswerSse(response);
    return { events, elapsedMs: Date.now() - started };
  };

  return {
    db,
    server,
    config,
    origin,
    budget,
    transcript,
    embeddings,
    llm,
    thresholds,
    forceWeak: (on) => {
      thresholds.strong = on ? 0.99 : calibrated.strong;
      thresholds.crossLanguageStrong = on ? 0.99 : calibrated.crossLanguageStrong;
    },
    ingest: (name) => ingestFixture(server, name, 240_000),
    ask: (client, documentId, question) => post(client, `/api/documents/${documentId}/ask`, { question }),
    reveal: (client, documentId, focus) => post(client, `/api/documents/${documentId}/reveal`, { focus }),
    close: async () => {
      await server.close();
      await db.close();
      await rm(TEST_ROOT, { recursive: true, force: true });
    },
  };
}

// --- reading an answer -----------------------------------------------------------------------------------------

export interface Answer {
  text: string;
  mode: string | null;
  grounded: boolean;
  refusedBy: string | null;
  citations: Citation[];
  error: string | null;
  evidence: string | null;
  rewrittenQuery: string | null;
  firstTokenMs: number | null;
  events: AnswerStreamEvent[];
}

export function interpret(events: readonly AnswerStreamEvent[]): Answer {
  const done = events.find((event) => event.type === 'done');
  const citations = events.find((event) => event.type === 'citations');
  const error = events.find((event) => event.type === 'error');
  const retrieval = events.find((event) => event.type === 'retrieval');
  return {
    text: done?.type === 'done' ? done.answer : '',
    mode: done?.type === 'done' ? done.mode : null,
    grounded: done?.type === 'done' ? done.grounded : false,
    refusedBy: done?.type === 'done' ? (done.refusedBy ?? null) : null,
    citations: citations?.type === 'citations' ? citations.citations : [],
    error:
      error?.type === 'error'
        ? `${error.error.code}${error.error.detail === undefined ? '' : ` (${error.error.detail})`}`
        : null,
    evidence: retrieval?.type === 'retrieval' ? retrieval.evidence : null,
    rewrittenQuery: retrieval?.type === 'retrieval' ? retrieval.rewrittenQuery : null,
    firstTokenMs: done?.type === 'done' ? done.timingsMs.firstToken : null,
    events: [...events],
  };
}

export const pagesOf = (citations: readonly Citation[]): number[] => [
  ...new Set(citations.map((citation) => citation.pageStart)),
];

export async function writeTaskData(name: string, content: string): Promise<void> {
  await mkdir(TASK_DATA, { recursive: true });
  await writeFile(path.join(TASK_DATA, name), content);
}
