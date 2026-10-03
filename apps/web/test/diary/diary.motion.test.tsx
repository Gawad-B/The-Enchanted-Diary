import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatStore } from '../../src/state/chatStore';
import { DOCUMENT_ID } from '../fixtures';
import { citation, done, mountDiary, openStream, retrieval, unmountDiary } from './harness';

const askPath = `POST /api/documents/${DOCUMENT_ID}/ask`;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'],
  });
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  unmountDiary();
  vi.useRealTimers();
});

const advance = async (ms: number): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

/** Writes and presses Enter without user-event (whose per-key timers fight the fake clock). */
async function ask(text: string): Promise<void> {
  const field = screen.getByRole('textbox');
  fireEvent.change(field, { target: { value: text } });
  fireEvent.keyDown(field, { key: 'Enter' });
  await advance(0);
}

/** What the pen has written of the reply on the page (the lines of the answer, joined). */
const inkOf = (container: HTMLElement): string =>
  [...container.querySelectorAll('.pg-line[data-role="answer"]')]
    .map((line) => line.textContent)
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();

const questionLine = (container: HTMLElement): HTMLElement | null =>
  container.querySelector<HTMLElement>('.pg-line[data-role="question"]');

describe('the choreography of a question (experience research section 4)', () => {
  it('holds the words 150 ms, sinks them word by word (520 ms each, 45 ms apart), and starts the reply 250 ms after the sink, even when the first token is already there', async () => {
    const stream = openStream();
    const { container } = mountDiary({ reduced: false, routes: { [askPath]: () => stream.response } });
    await ask('Who founded it?');
    const question = questionLine(container);
    expect(question).toHaveAttribute('data-state', 'sinking');
    expect(question?.style.getPropertyValue('--sink-hold')).toBe('150ms');
    expect(question?.style.getPropertyValue('--sink-word')).toBe('520ms');
    expect(question?.style.getPropertyValue('--sink-stagger')).toBe('45ms');
    expect(container.querySelectorAll('.ink-q__w')).toHaveLength(3);
    stream.send(
      { type: 'token', text: 'It was founded in 1847.' },
      { type: 'citations', citations: [citation()], consulted: [] },
      done({ answer: 'It was founded in 1847.' }),
    );
    stream.end();
    await advance(300);
    // 3 words: hold 150 + sink (520 + 2 x 45 = 610) + breath 250 = 1010 ms: not yet
    expect(inkOf(container)).toBe('');
    expect(container.querySelector('.ink-listening')).toBeInTheDocument();
    await advance(900); // 1200 ms in
    expect(inkOf(container).length).toBeGreaterThan(0);
    expect(container.querySelector('.ink-listening')).not.toBeInTheDocument();
    // and it is all written no later than 1.2 s after the stream ended (here the stream had ended at once)
    await advance(1500);
    expect(inkOf(container)).toBe('It was founded in 1847.');
  });

  it('the pen follows the stream: what has not arrived is not written, and it is finished 1.2 s after the end', async () => {
    const stream = openStream();
    const { container } = mountDiary({ reduced: false, routes: { [askPath]: () => stream.response } });
    await ask('Q');
    await advance(1500); // past the sink
    stream.send({ type: 'token', text: 'The house stands ' });
    await advance(600);
    const early = inkOf(container);
    expect('The house stands '.startsWith(early.trimEnd()) || early.startsWith('The house')).toBe(true);
    expect(early.length).toBeLessThanOrEqual('The house stands '.length);
    stream.send({ type: 'token', text: 'on a low hill above the river and the old mill.' });
    await advance(100);
    stream.send(
      { type: 'citations', citations: [], consulted: [] },
      done({ answer: 'The house stands on a low hill above the river and the old mill.' }),
    );
    stream.end();
    await advance(1400);
    expect(inkOf(container)).toBe('The house stands on a low hill above the river and the old mill.');
  });

  it("the first sentence is in the diary's hand and the rest is fair copy", async () => {
    const stream = openStream();
    const { container } = mountDiary({ reduced: false, routes: { [askPath]: () => stream.response } });
    await ask('Q');
    stream.send(
      { type: 'citations', citations: [], consulted: [] },
      done({ answer: 'It was founded in 1847. A workroom with tall windows followed.' }),
    );
    stream.end();
    await advance(4000);
    const lead = [...container.querySelectorAll('.ink-u--lead')].map((span) => span.textContent).join('');
    const fair = [...container.querySelectorAll('.ink-u--fair')].map((span) => span.textContent).join('');
    expect(lead).toBe('Itwasfoundedin1847.');
    expect(fair.startsWith('Aworkroom')).toBe(true);
  });

  it('sources appear only once the whole reply is written', async () => {
    const stream = openStream();
    mountDiary({ reduced: false, routes: { [askPath]: () => stream.response } });
    await ask('Q');
    stream.send(
      {
        type: 'token',
        text: 'A fairly long reply that takes a while to be written out in full, glyph by glyph.',
      },
      { type: 'citations', citations: [citation()], consulted: [] },
      done({ answer: 'A fairly long reply that takes a while to be written out in full, glyph by glyph.' }),
    );
    stream.end();
    await advance(1300);
    expect(screen.queryByRole('button', { name: 'Show me the truth' })).not.toBeInTheDocument();
    await advance(3000);
    expect(screen.getByRole('button', { name: 'Show me the truth' })).toBeInTheDocument();
  });

  it('the diary says it needs a moment after 6 s and is searching the deeper pages after 15 s', async () => {
    const stream = openStream();
    mountDiary({ reduced: false, routes: { [askPath]: () => stream.response } });
    await ask('Q');
    stream.send({ type: 'status', stage: 'retrieving', elapsedMs: 1 }, retrieval);
    await advance(2000);
    expect(screen.getByText('Searching the pages…')).toBeInTheDocument();
    stream.raw(': hb\n\n');
    await advance(4500); // 6.5 s
    expect(screen.getByText("Give me a moment. The ink hasn't dried yet.")).toBeInTheDocument();
    stream.raw(': hb\n\n');
    await advance(9000); // 15.5 s
    expect(screen.getByText('Still searching the deeper pages. Thank you for waiting.')).toBeInTheDocument();
    // the real figures stay beside the line
    expect(document.querySelector('.ink-listening__technical')).toHaveTextContent('Searched 312 passages');
    stream.end();
  });

  it('20 seconds without any byte is the "connection interrupted" state; heartbeats keep the wait alive', async () => {
    const stream = openStream();
    mountDiary({ reduced: false, routes: { [askPath]: () => stream.response } });
    await ask('Q');
    for (let i = 0; i < 5; i += 1) {
      await advance(5000);
      stream.raw(': hb\n\n'); // a heartbeat every 5 s, as the server sends one
    }
    expect(chatStore.getState().turn?.status).toBe('asking'); // 25 s in, still waiting
    await advance(20_100); // then nothing at all
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('The connection to the archive was interrupted.');
    expect(chatStore.getState().turn?.error?.code).toBe('NETWORK');
  });
});

describe('reduced motion', () => {
  it('replaces the sink with one short crossfade of the whole block: no hold, no stagger', async () => {
    const stream = openStream();
    const { container } = mountDiary({ reduced: true, routes: { [askPath]: () => stream.response } });
    await ask('Who founded it?');
    const question = questionLine(container);
    expect(question).toHaveAttribute('data-crossfade', 'true');
    expect(question?.style.getPropertyValue('--sink-hold')).toBe('0ms');
    expect(question?.style.getPropertyValue('--sink-stagger')).toBe('0ms');
    expect(question?.style.getPropertyValue('--sink-word')).toBe('250ms');
    stream.end();
  });

  it('shows the reply as soon as it may start (250 ms), whole, with no pen and no specks', async () => {
    const stream = openStream();
    const { container } = mountDiary({ reduced: true, routes: { [askPath]: () => stream.response } });
    await ask('Q');
    stream.send(
      { type: 'citations', citations: [citation()], consulted: [] },
      done({ answer: 'It was founded in 1847 in a long sentence that would take seconds to write.' }),
    );
    stream.end();
    await advance(400);
    expect(inkOf(container)).toBe(
      'It was founded in 1847 in a long sentence that would take seconds to write.',
    );
    expect(container.querySelectorAll('.quill__speck')).toHaveLength(0);
  });
});
