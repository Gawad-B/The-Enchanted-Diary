const BYTE_ORDER_MARK = 0xfeff;

/** One dispatched Server-Sent Event. `event` is "message" unless the frame named another type. */
export interface SseEvent {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

export interface SseParserOptions {
  /** Called with the text of each comment frame (": hb" heartbeats arrive here). */
  onComment?: (text: string) => void;
}

export interface SseParser {
  /** Feed the next chunk of the stream as text. Chunks may split anywhere, even between "\r" and "\n". */
  push(chunk: string): void;
  /** Call when the stream ends: an unterminated final frame is discarded, as the specification requires. */
  end(): void;
}

/**
 * An incremental parser for the text/event-stream format (WHATWG HTML section 9.2), used for both POST
 * streams (fetch + ReadableStream) and GET streams. It follows the specification: lines end in \n, \r or
 * \r\n; a blank line dispatches the event; several `data:` lines join with \n; lines starting with ":" are
 * comments; one leading space after the colon is dropped; an event without data is not dispatched.
 */
export function createSseParser(
  onEvent: (event: SseEvent) => void,
  options: SseParserOptions = {},
): SseParser {
  let pending = '';
  let started = false;
  let dataLines: string[] = [];
  let eventType = '';
  let lastId: string | undefined;
  let retry: number | undefined;

  function dispatch(): void {
    if (dataLines.length > 0) {
      const event: SseEvent = { event: eventType === '' ? 'message' : eventType, data: dataLines.join('\n') };
      if (lastId !== undefined) event.id = lastId;
      if (retry !== undefined) event.retry = retry;
      onEvent(event);
    }
    dataLines = [];
    eventType = '';
    retry = undefined;
  }

  function handleLine(line: string): void {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) {
      options.onComment?.(line.slice(1).replace(/^ /, ''));
      return;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    switch (field) {
      case 'data':
        dataLines.push(value);
        break;
      case 'event':
        eventType = value;
        break;
      case 'id':
        if (!value.includes('\0')) lastId = value;
        break;
      case 'retry':
        if (/^\d+$/.test(value)) retry = Number(value);
        break;
      default:
        break; // unknown fields are ignored
    }
  }

  return {
    push(chunk) {
      pending += chunk;
      if (!started && pending.length > 0) {
        started = true;
        if (pending.charCodeAt(0) === BYTE_ORDER_MARK) pending = pending.slice(1);
      }
      let start = 0;
      for (let i = 0; i < pending.length; i += 1) {
        const character = pending[i];
        if (character !== '\n' && character !== '\r') continue;
        // A "\r" at the very end may be the first half of "\r\n": wait for the next chunk to know.
        if (character === '\r' && i === pending.length - 1) break;
        handleLine(pending.slice(start, i));
        if (character === '\r' && pending[i + 1] === '\n') i += 1;
        start = i + 1;
      }
      pending = pending.slice(start);
    },
    end() {
      // A trailing "\r" was a complete line terminator after all.
      if (pending === '\r') handleLine('');
      pending = '';
      dataLines = [];
      eventType = '';
      retry = undefined;
    },
  };
}
