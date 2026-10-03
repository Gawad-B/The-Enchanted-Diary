import type { DocumentDetail, DocumentSummary, IngestTickResponse } from '@enchanted/shared';
import {
  ApiErrorSchema,
  DocumentDetailSchema,
  DocumentSummarySchema,
  IngestTickResponseSchema,
} from '@enchanted/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import { buildApp, type AppDeps } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { Db } from '../src/db/client.js';
import { SESSION_COOKIE } from '../src/session/session.js';
import type { EmbeddingProvider } from '../src/embeddings/provider.js';
import { FakeEmbeddings } from './doubles/fake-embeddings.js';
import { readFixture } from './fixtures.js';

export interface UploadOptions {
  field?: string;
  filename?: string;
  contentType?: string;
  /** Extra multipart parts, written before the file. */
  before?: FormPart[];
  /** Extra multipart parts, written after the file. */
  after?: FormPart[];
}

interface FormPart {
  name: string;
  value: string;
  contentType?: string;
}

/** A multipart/form-data body with one file part (and optionally other parts). */
export function multipartBody(
  bytes: Uint8Array | Buffer,
  options: UploadOptions = {},
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----diary-test-${Math.random().toString(16).slice(2)}`;
  const formPart = (part: FormPart): Buffer =>
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n${part.contentType === undefined ? '' : `Content-Type: ${part.contentType}\r\n`}\r\n${part.value}\r\n`,
    );
  const chunks: Buffer[] = (options.before ?? []).map(formPart);
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${options.field ?? 'file'}"; filename="${options.filename ?? 'manuscript.pdf'}"\r\nContent-Type: ${options.contentType ?? 'application/pdf'}\r\n\r\n`,
    ),
    Buffer.from(bytes),
    Buffer.from('\r\n'),
    ...(options.after ?? []).map(formPart),
    Buffer.from(`--${boundary}--\r\n`),
  );
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/** An API client with its own cookie jar (its own session). */
export class Client {
  cookie: string | undefined;

  constructor(readonly app: FastifyInstance) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...(this.cookie === undefined ? {} : { cookie: `${SESSION_COOKIE}=${this.cookie}` }), ...extra };
  }

  private remember(response: LightMyRequestResponse): LightMyRequestResponse {
    this.cookie = response.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? this.cookie;
    return response;
  }

  async request(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    extra: { payload?: Buffer; headers?: Record<string, string> } = {},
  ): Promise<LightMyRequestResponse> {
    return this.remember(
      await this.app.inject({
        method,
        url,
        headers: this.headers(extra.headers),
        ...(extra.payload === undefined ? {} : { payload: extra.payload }),
      }),
    );
  }

  get(url: string): Promise<LightMyRequestResponse> {
    return this.request('GET', url);
  }

  delete(url: string): Promise<LightMyRequestResponse> {
    return this.request('DELETE', url);
  }

  /** A POST with a JSON body. */
  postJson(url: string, body: unknown): Promise<LightMyRequestResponse> {
    return this.request('POST', url, {
      payload: Buffer.from(JSON.stringify(body)),
      headers: { 'content-type': 'application/json' },
    });
  }

  upload(bytes: Uint8Array | Buffer, options: UploadOptions = {}): Promise<LightMyRequestResponse> {
    const { payload, headers } = multipartBody(bytes, options);
    return this.request('POST', '/api/documents', { payload, headers });
  }

  async uploadFixture(name: string, options: UploadOptions = {}): Promise<LightMyRequestResponse> {
    return this.upload(await readFixture(name), { filename: name, ...options });
  }

  /** Acts as an existing session (the cookie the server would have issued for it). */
  asSession(sessionId: string): this {
    this.cookie = this.app.signCookie(sessionId);
    return this;
  }

  /** The Cookie header value for requests made outside inject (fetch). */
  cookieHeader(): Record<string, string> {
    return this.cookie === undefined ? {} : { cookie: `${SESSION_COOKIE}=${this.cookie}` };
  }
}

export function errorOf(response: LightMyRequestResponse): {
  code: string;
  message: string;
  detail?: string;
} {
  return ApiErrorSchema.parse(response.json()).error;
}

export function summaryOf(response: LightMyRequestResponse): DocumentSummary {
  expect(response.statusCode, response.body).toBe(202);
  return DocumentSummarySchema.parse(response.json<{ document: unknown }>().document);
}

export async function detailOf(client: Client, id: string): Promise<DocumentDetail> {
  const response = await client.get(`/api/documents/${id}`);
  expect(response.statusCode, response.body).toBe(200);
  return DocumentDetailSchema.parse(response.json());
}

/** One tick of the document's ingestion, as the client makes it. */
export async function tickOnce(client: Client, id: string): Promise<IngestTickResponse> {
  const response = await client.request('POST', `/api/documents/${id}/tick`);
  expect(response.statusCode, response.body).toBe(200);
  return IngestTickResponseSchema.parse(response.json());
}

/**
 * Does what the web app does: ticks the document until it is ready or failed, and returns every answer on the way (for tests
 * that look at the progress). A parked document ends the loop too (its answer is the last one). `onTick` sees each answer.
 */
export async function tickUntilDone(
  client: Client,
  id: string,
  options: { timeoutMs?: number; onTick?: (answer: IngestTickResponse) => void | Promise<void> } = {},
): Promise<IngestTickResponse[]> {
  // (Long enough for a loaded machine: a test that waits for a document has a deadline of its own that is longer still.)
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  const answers: IngestTickResponse[] = [];
  for (;;) {
    const answer = await tickOnce(client, id);
    answers.push(answer);
    await options.onTick?.(answer);
    if (answer.status !== 'running') return answers;
    if (Date.now() > deadline) throw new Error(`document ${id} still ${answer.progress.stage} after ticking`);
    if (answer.retryAfterMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(answer.retryAfterMs ?? 0, 100)));
    }
  }
}

export interface BackgroundTicks {
  /** Every 200 answer, in order. */
  answers: IngestTickResponse[];
  /** The refusal that ended the loop (a removed document answers 404), or null when the document ended or parked. */
  stoppedBy: { statusCode: number; code: string } | null;
}

/**
 * Ticks the document in the background, as an open browser tab does, without failing on an error answer: for tests that
 * remove the document (or do something else to it) while it is being read. Resolves when the document is ready, failed or
 * parked, or when a tick is refused.
 */
export async function keepTicking(client: Client, id: string, timeoutMs = 90_000): Promise<BackgroundTicks> {
  const deadline = Date.now() + timeoutMs;
  const result: BackgroundTicks = { answers: [], stoppedBy: null };
  for (;;) {
    const response = await client.request('POST', `/api/documents/${id}/tick`);
    if (response.statusCode !== 200) {
      result.stoppedBy = { statusCode: response.statusCode, code: errorOf(response).code };
      return result;
    }
    const answer = IngestTickResponseSchema.parse(response.json());
    result.answers.push(answer);
    if (answer.status !== 'running' || Date.now() > deadline) return result;
    await new Promise((resolve) => setTimeout(resolve, Math.min(answer.retryAfterMs ?? 0, 50)));
  }
}

/** Ticks the document until it is ready or failed (as the web app does) and returns it. */
export async function waitForDocument(
  client: Client,
  id: string,
  timeoutMs = 120_000,
): Promise<DocumentDetail> {
  const answers = await tickUntilDone(client, id, { timeoutMs });
  const last = answers.at(-1);
  if (last?.status === 'parked') throw new Error(`document ${id} is parked: ${last.progress.detail ?? ''}`);
  return detailOf(client, id);
}

export async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export interface TestServer {
  app: FastifyInstance;
  config: Config;
  embeddings: EmbeddingProvider;
  client(): Client;
  close(): Promise<void>;
}

/** The whole server on a shared in-memory database, with the real worker threads and a fake embedding model. */
export async function startServer(
  db: Db,
  config: Config,
  options: { embeddings?: EmbeddingProvider; deps?: AppDeps } = {},
): Promise<TestServer> {
  const embeddings = options.embeddings ?? new FakeEmbeddings();
  const app = await buildApp(config, {
    db,
    ...options.deps,
    ingestion: { embeddings, ...options.deps?.ingestion },
  });
  return {
    app,
    config,
    embeddings,
    client: () => new Client(app),
    close: () => app.close(),
  };
}

/** The id of the session a client acts as (making it exist first, as any request of a fresh client does). */
export async function sessionOf(client: Client): Promise<string> {
  const response = await client.get('/api/session/document');
  if (response.statusCode !== 200) throw new Error(`session request answered ${String(response.statusCode)}`);
  const id = client.app.unsignCookie(client.cookie ?? '').value;
  if (id === null) throw new Error('no session');
  return id;
}
