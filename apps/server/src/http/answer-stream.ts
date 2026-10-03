import type { AnswerStreamEvent } from '@enchanted/shared';
import type { FastifyReply } from 'fastify';
import type { Config } from '../config.js';
import { applySecurityHeaders } from './security.js';
import { openSse } from './sse.js';

export interface AnswerStream {
  emit: (event: AnswerStreamEvent) => void;
  end: () => void;
  /** Aborted when the visitor's connection closes before the stream was ended. */
  readonly signal: AbortSignal;
}

/**
 * Starts watching the visitor's connection NOW, before any database work: if the client goes away while the route is still
 * looking up the document, nothing must be spent on its behalf (up to three model requests). The controller aborts when the
 * connection closes before the response was finished.
 */
export function watchClient(reply: FastifyReply): AbortController {
  const controller = new AbortController();
  const gone = (): void => {
    if (!reply.raw.writableEnded) controller.abort(new DOMException('The client went away', 'AbortError'));
  };
  if (reply.raw.destroyed) gone();
  else reply.raw.on('close', gone);
  return controller;
}

/**
 * Opens the event stream of an ask or reveal: Server-Sent Events with a `: hb` comment every `heartbeatMs`, and an
 * AbortSignal that fires when the connection closes before the response was finished (a closed tab, a cancelled
 * request), so the language model stops generating for nobody. `client` is the controller `watchClient` made at the start of
 * the request.
 */
export function openAnswerStream(
  reply: FastifyReply,
  config: Config,
  heartbeatMs: number,
  client: AbortController = watchClient(reply),
): AnswerStream {
  applySecurityHeaders(reply, { csp: config.isProduction });
  const stream = openSse(reply, heartbeatMs);
  return {
    emit: (event) => stream.send(event),
    end: () => stream.end(),
    signal: client.signal,
  };
}
