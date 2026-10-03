import type { FastifyReply } from 'fastify';

export interface SseStream {
  /** Sends one event as a `data:` frame (JSON, no `event:` name: the payload carries its own `type`). */
  send(event: unknown): void;
  /** Ends the stream. */
  end(): void;
  /** True once the client went away or the stream was ended. */
  readonly closed: boolean;
  /** Registers cleanup to run once, when the stream ends or the client disconnects. */
  onClose(callback: () => void): void;
}

/**
 * Turns the reply into a Server-Sent Events stream. The reply is hijacked, so the headers set on it so far (the
 * security headers, the session cookie) are written by hand together with the event-stream ones. A heartbeat
 * comment (`: hb`) goes out every `heartbeatMs` so proxies keep the connection open.
 */
export function openSse(reply: FastifyReply, heartbeatMs: number): SseStream {
  reply.header('Content-Type', 'text/event-stream; charset=utf-8');
  reply.header('Cache-Control', 'no-store, no-transform'); // no-transform: a proxy must not compress or re-chunk the stream
  reply.header('X-Accel-Buffering', 'no'); // nginx: do not buffer the stream
  reply.hijack();
  const raw = reply.raw;
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) raw.setHeader(name, typeof value === 'number' ? String(value) : value);
  }
  raw.writeHead(200);
  raw.flushHeaders();

  const callbacks: (() => void)[] = [];
  let closed = false;
  const finish = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const callback of callbacks.splice(0)) callback();
  };
  const heartbeat = setInterval(() => {
    if (!closed) raw.write(': hb\n\n');
  }, heartbeatMs);
  heartbeat.unref();
  raw.on('close', finish);

  return {
    send(event) {
      if (!closed) raw.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    end() {
      if (closed) return;
      raw.end();
      finish();
    },
    get closed() {
      return closed;
    },
    onClose(callback) {
      if (closed) callback();
      else callbacks.push(callback);
    },
  };
}
