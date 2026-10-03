import { vi } from 'vitest';

/*
 * The network boundary as a test double (tests only): a stand-in for XMLHttpRequest that records what was sent and lets the
 * test play the server's side (progress events, the answer, a failure), and a stand-in for `fetch` routed by method and path.
 */

export class FakeXhr {
  static instances: FakeXhr[] = [];
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown = null;
  status = 0;
  statusText = '';
  responseText = '';
  responseType = '';
  aborted = false;
  upload: {
    onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
  } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXhr.instances.push(this);
  }
  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
  send(body: unknown): void {
    this.body = body;
  }
  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }

  // --- the server's side ---
  progress(loaded: number, total: number): void {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  respond(status: number, body: unknown): void {
    this.status = status;
    this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
    this.onload?.();
  }
  fail(): void {
    this.onerror?.();
  }
  static last(): FakeXhr {
    const xhr = FakeXhr.instances.at(-1);
    if (!xhr) throw new Error('no XMLHttpRequest was made');
    return xhr;
  }
  static install(): void {
    FakeXhr.instances = [];
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
  }
}

export interface FetchCall {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
  signal: AbortSignal | undefined;
}

type Handler = (call: FetchCall) => Response | Promise<Response>;

/** Routes `fetch` by "METHOD /path"; records every call; an unrouted call fails the test loudly. */
export function installFetch(routes: Record<string, Handler>): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        'http://localhost',
      );
      const method = (init.method ?? 'GET').toUpperCase();
      let body: unknown = init.body ?? null;
      if (typeof body === 'string') {
        try {
          body = JSON.parse(body);
        } catch {
          // keep the string
        }
      }
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      const call: FetchCall = { method, path: url.pathname, body, headers, signal: init.signal ?? undefined };
      calls.push(call);
      const handler = routes[`${method} ${url.pathname}`];
      if (!handler) return Promise.reject(new Error(`unrouted request: ${method} ${url.pathname}`));
      return Promise.resolve(handler(call));
    }),
  );
  return { calls };
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const apiError = (status: number, code: string, message = 'refused', detail?: string): Response =>
  json(status, { error: { code, message, ...(detail ? { detail } : {}) } });
