import { describe, expect, it } from 'vitest';
import { createSseParser, type SseEvent } from '../../src/api/sse';

function parse(chunks: string[]): { events: SseEvent[]; comments: string[] } {
  const events: SseEvent[] = [];
  const comments: string[] = [];
  const parser = createSseParser((event) => events.push(event), { onComment: (text) => comments.push(text) });
  for (const chunk of chunks) parser.push(chunk);
  parser.end();
  return { events, comments };
}

const STREAM =
  ': hb\n\n' +
  'data: {"type":"status"}\n\n' +
  'event: progress\ndata: line one\ndata: line two\n\n' +
  'id: 7\ndata: with id\n\n' +
  'retry: 3000\ndata: with retry\n\n' +
  ': another comment\n' +
  'data: last\n\n';

const EXPECTED: SseEvent[] = [
  { event: 'message', data: '{"type":"status"}' },
  { event: 'progress', data: 'line one\nline two' },
  { event: 'message', data: 'with id', id: '7' },
  { event: 'message', data: 'with retry', id: '7', retry: 3000 },
  { event: 'message', data: 'last', id: '7' },
];

describe('createSseParser', () => {
  it('parses a whole stream delivered in one chunk', () => {
    const { events, comments } = parse([STREAM]);
    expect(events).toEqual(EXPECTED);
    expect(comments).toEqual(['hb', 'another comment']);
  });

  it('gives the same events however the stream is split, even one character at a time', () => {
    for (let cut = 1; cut < STREAM.length; cut += 1) {
      expect(parse([STREAM.slice(0, cut), STREAM.slice(cut)]).events).toEqual(EXPECTED);
    }
    const oneByOne = Array.from({ length: STREAM.length }, (_, index) => STREAM.charAt(index));
    expect(parse(oneByOne).events).toEqual(EXPECTED);
  });

  it('handles a frame split between the field name and its value', () => {
    expect(parse(['da', 'ta: hel', 'lo\n', '\n']).events).toEqual([{ event: 'message', data: 'hello' }]);
  });

  it('joins several data lines with a newline, keeping empty lines', () => {
    expect(parse(['data: a\ndata:\ndata: c\n\n']).events).toEqual([{ event: 'message', data: 'a\n\nc' }]);
  });

  it('drops exactly one leading space after the colon', () => {
    expect(parse(['data:  two spaces\n\ndata:none\n\n']).events.map((event) => event.data)).toEqual([
      ' two spaces',
      'none',
    ]);
  });

  it('treats comments and heartbeats as comments, never as events', () => {
    const { events, comments } = parse([': hb\n\n: hb\n\n']);
    expect(events).toEqual([]);
    expect(comments).toEqual(['hb', 'hb']);
  });

  it('accepts \\n, \\r and \\r\\n line endings, including \\r\\n split across chunks', () => {
    const expected = [
      { event: 'message', data: 'x' },
      { event: 'message', data: 'y' },
    ];
    expect(parse(['data: x\n\ndata: y\n\n']).events).toEqual(expected);
    expect(parse(['data: x\r\rdata: y\r\r']).events).toEqual(expected);
    expect(parse(['data: x\r\n\r\ndata: y\r\n\r\n']).events).toEqual(expected);
    expect(parse(['data: x\r', '\n\r', '\ndata: y\r', '\n\r\n']).events).toEqual(expected);
  });

  it('does not dispatch an event that has no data', () => {
    expect(parse(['event: ping\n\n', 'id: 3\n\n']).events).toEqual([]);
  });

  it('resets the event type after each dispatch', () => {
    const { events } = parse(['event: a\ndata: 1\n\ndata: 2\n\n']);
    expect(events.map((event) => event.event)).toEqual(['a', 'message']);
  });

  it('ignores unknown fields, ids containing NUL and non-numeric retry values', () => {
    const { events } = parse(['foo: bar\nid: a\u0000b\nretry: soon\ndata: ok\n\n']);
    expect(events).toEqual([{ event: 'message', data: 'ok' }]);
  });

  it('treats a line without a colon as a field with an empty value', () => {
    expect(parse(['data\n\n']).events).toEqual([{ event: 'message', data: '' }]);
  });

  it('strips a byte order mark at the start of the stream', () => {
    const bom = String.fromCharCode(0xfeff);
    expect(parse([`${bom}data: x\n\n`]).events).toEqual([{ event: 'message', data: 'x' }]);
    expect(parse([bom, 'data: x\n\n']).events).toEqual([{ event: 'message', data: 'x' }]);
  });

  it('discards an unterminated final frame when the stream ends', () => {
    expect(parse(['data: complete\n\ndata: cut off']).events).toEqual([
      { event: 'message', data: 'complete' },
    ]);
  });

  it('keeps multi-byte text intact', () => {
    expect(parse(['data: مرحبا بالعالم\n\n']).events[0]?.data).toBe('مرحبا بالعالم');
  });
});
