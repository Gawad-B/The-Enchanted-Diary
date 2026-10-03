import { ApiError, type GenerateContentParameters, type GenerateContentResponse } from '@google/genai';
import { PDFDocument } from 'pdf-lib';
import type { GeminiClient } from '../../src/gemini/index.js';

/*
 * A stand-in for the Gemini client of the OCR provider: it records every request and plays a script. Nothing here reaches
 * Google. Test code only.
 */

/** What one request asked for, decoded. */
export interface SeenRequest {
  params: GenerateContentParameters;
  mimeType: string;
  /** The inline file. */
  data: Buffer;
  /** Pages in the inline file (1 for an image). */
  pageCount: number;
  /** The text part of the request. */
  prompt: string;
}

/** The answer of the model for one request: a JSON-able value or text, an error to throw, or a ready response. */
export type FakeReply = string | object | Error | GenerateContentResponse;

export type FakeHandler = (request: SeenRequest, index: number) => FakeReply | Promise<FakeReply>;

/** A response whose only part is `text`. */
export const textResponse = (text: string, finishReason?: string): GenerateContentResponse =>
  ({
    candidates: [{ content: { parts: [{ text }] }, ...(finishReason === undefined ? {} : { finishReason }) }],
  }) as unknown as GenerateContentResponse;

const isResponse = (value: unknown): value is GenerateContentResponse =>
  typeof value === 'object' && value !== null && 'candidates' in value;

/** The pages of a model answer, `[{page, lines}]` with the lines given. */
export const answerFor = (pages: readonly (string[] | null)[]): { page: number; lines: string[] }[] =>
  pages.flatMap((lines, index) => (lines === null ? [] : [{ page: index + 1, lines }]));

export class FakeGeminiClient implements GeminiClient {
  readonly requests: SeenRequest[] = [];

  constructor(private readonly handler: FakeHandler) {}

  readonly models = {
    generateContent: async (params: GenerateContentParameters): Promise<GenerateContentResponse> => {
      const parts = (
        params.contents as { parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] }[]
      )[0]?.parts;
      const inline = parts?.find((part) => part.inlineData !== undefined)?.inlineData;
      const data = Buffer.from(inline?.data ?? '', 'base64');
      const mimeType = inline?.mimeType ?? '';
      const seen: SeenRequest = {
        params,
        mimeType,
        data,
        pageCount: mimeType === 'application/pdf' ? (await PDFDocument.load(data)).getPageCount() : 1,
        prompt: parts?.find((part) => part.text !== undefined)?.text ?? '',
      };
      this.requests.push(seen);
      const reply = await this.handler(seen, this.requests.length - 1);
      if (reply instanceof Error) throw reply;
      if (isResponse(reply)) return reply;
      return textResponse(typeof reply === 'string' ? reply : JSON.stringify(reply));
    },
  } as GeminiClient['models'];
}

/** A client that answers every page of every request with `Page <batch>.<page> text`. */
export const echoingClient = (): FakeGeminiClient =>
  new FakeGeminiClient((request, index) =>
    answerFor(
      Array.from({ length: request.pageCount }, (_, page) => [
        `Request ${String(index + 1)} page ${String(page + 1)} first line`,
        '',
        `Request ${String(index + 1)} page ${String(page + 1)} second paragraph`,
      ]),
    ),
  );

/** An error as the SDK throws it for an HTTP failure. */
export const apiError = (status: number, error: object = {}): ApiError =>
  new ApiError({ status, message: JSON.stringify({ error: { code: status, ...error } }) });

/** The 429 of a per-minute rate limit, with the delay the service asks for. */
export const rateLimited = (retryDelay = '1s'): ApiError =>
  apiError(429, {
    status: 'RESOURCE_EXHAUSTED',
    message: 'Resource has been exhausted',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay },
    ],
  });

/** The 429 of the daily quota: waiting a minute does not help. */
export const dailyQuota = (): ApiError =>
  apiError(429, {
    status: 'RESOURCE_EXHAUSTED',
    message: 'You exceeded your current quota',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '39600s' },
    ],
  });

/** An answer that a safety filter stopped. */
export const blockedResponse = (): GenerateContentResponse =>
  ({ candidates: [{ finishReason: 'SAFETY' }] }) as unknown as GenerateContentResponse;
