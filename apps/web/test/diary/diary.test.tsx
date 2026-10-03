import { startRevealEffect } from '../../src/state/effects/reveal';
import { revealStore } from '../../src/reveal/revealStore';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { anchorStore } from '../../src/state/anchorStore';
import { chatStore } from '../../src/state/chatStore';
import { diaryBookStore } from '../../src/state/diaryBook';
import { experienceStore } from '../../src/state/experience';
import { readerStore } from '../../src/state/readerStore';
import { LIVE_AFTER_MS } from '../../src/ui/diary/useSurface';
import { DOCUMENT_ID } from '../fixtures';
import { apiError } from '../helpers/network';
import {
  LEFT_PAGE,
  RIGHT_PAGE,
  citation,
  done,
  mountDiary,
  openStream,
  retrieval,
  settle,
  unmountDiary,
} from './harness';

/*
 * Writing in the diary, on the page of the book (global section T). The surface is the diary's page laid onto the 3D leaf; here
 * the camera is a fixed pair of quads, the stores are the real ones and the network is mocked.
 */

afterEach(() => {
  unmountDiary();
});

const askPath = `POST /api/documents/${DOCUMENT_ID}/ask`;
const writeBox = (): HTMLTextAreaElement => screen.getByRole<HTMLTextAreaElement>('textbox');
/** What is written on the page, line by line (the page's own ink layer). */
const ink = (container: HTMLElement): string =>
  [...container.querySelectorAll('.pg-line')]
    .map((line) => line.textContent)
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();
const answerInk = (container: HTMLElement): string =>
  [...container.querySelectorAll('.pg-line[data-role="answer"]')]
    .map((line) => line.textContent)
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();

async function ask(text: string): Promise<void> {
  const user = userEvent.setup();
  await user.type(writeBox(), `${text}{Enter}`);
}

describe('the writing surface', () => {
  it("is the diary's page, there while the reader writes in the manuscript and gone when they are not", () => {
    mountDiary({ idle: true });
    expect(screen.queryByTestId('diary-surface')).not.toBeInTheDocument();
    act(() => {
      diaryBookStore.getState().startWriting();
    });
    expect(screen.getByTestId('diary-surface')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: "The diary's page" })).toBe(
      screen.getByTestId('diary-surface'),
    );
  });

  it('is not on the stage in the closed diary, while uploading, or in the reveal and the memory', () => {
    for (const phase of [
      'discovery',
      'opening',
      'uploading',
      'reading',
      'unveiling',
      'revealing',
      'memory',
    ] as const) {
      mountDiary({ phase });
      expect(screen.queryByTestId('diary-surface'), phase).not.toBeInTheDocument();
      expect(diaryBookStore.getState().writing, phase).toBe(false);
      unmountDiary();
    }
  });

  it('the reveal takes the stage: the dive ends when the phase leaves the manuscript', async () => {
    mountDiary({ phase: 'manuscript' });
    expect(diaryBookStore.getState().writing).toBe(true);
    act(() => {
      experienceStore.setState({ phase: 'revealing', epoch: 9 });
    });
    expect(diaryBookStore.getState().writing).toBe(false);
    await vi.waitFor(() => {
      expect(screen.queryByTestId('diary-surface')).not.toBeInTheDocument();
    });
  });

  it('shows only while the camera is at rest on the page and the book is still', () => {
    mountDiary();
    const surface = screen.getByTestId('diary-surface');
    expect(surface).toHaveAttribute('data-ready', 'true');
    act(() => {
      anchorStore.getState().setStable(false);
    });
    expect(surface).toHaveAttribute('data-ready', 'false');
    expect(surface).toHaveAttribute('inert');
    act(() => {
      anchorStore.getState().setStable(true);
      diaryBookStore.getState().setMoving(true);
    });
    expect(surface).toHaveAttribute('data-ready', 'false');
    act(() => {
      diaryBookStore.getState().setMoving(false);
    });
    expect(surface).toHaveAttribute('data-ready', 'true');
    expect(surface).not.toHaveAttribute('inert');
  });

  it('lies on the unturned page of the book: the right-hand page of a left-to-right book, the left-hand page of a right-to-left one', () => {
    mountDiary({ direction: 'ltr' });
    const ltr = screen.getByTestId('diary-surface').style.transform;
    expect(ltr).toMatch(/^matrix3d\(/u);
    expect(screen.getByTestId('diary-surface')).toHaveAttribute('data-placed', 'true');
    unmountDiary();
    mountDiary({ direction: 'rtl', language: 'ar' });
    const rtl = screen.getByTestId('diary-surface').style.transform;
    expect(rtl).toMatch(/^matrix3d\(/u);
    expect(rtl).not.toBe(ltr);
    // The matrix carries the page's corner to the page's corner: its translation is the quad's first point.
    const translation = (transform: string) =>
      transform.slice('matrix3d('.length, -1).split(',').map(Number).slice(12, 14);
    expect(translation(ltr)).toEqual([RIGHT_PAGE[0].x, RIGHT_PAGE[0].y]);
    expect(translation(rtl)).toEqual([LEFT_PAGE[0].x, LEFT_PAGE[0].y]);
  });

  it('is not shown until the camera has said where the page is', () => {
    mountDiary();
    act(() => {
      anchorStore.getState().setQuads({ leftPage: null, rightPage: null });
    });
    expect(screen.getByTestId('diary-surface')).toHaveAttribute('data-ready', 'false');
    expect(screen.getByTestId('diary-surface')).toHaveAttribute('data-placed', 'false');
  });

  it("hands the page its ink back the moment the reader steps back: Escape, a tap beside the page, or the page's own button", async () => {
    const user = userEvent.setup();
    mountDiary();
    await vi.waitFor(
      () => {
        expect(diaryBookStore.getState().livePage).toBe(0);
      },
      { timeout: LIVE_AFTER_MS * 4 },
    );
    await user.keyboard('{Escape}');
    expect(diaryBookStore.getState().writing).toBe(false);
    expect(diaryBookStore.getState().livePage).toBeNull();
    unmountDiary();

    mountDiary();
    await user.click(screen.getByRole('button', { name: 'Step back from the page' }));
    expect(diaryBookStore.getState().writing).toBe(false);
    unmountDiary();

    mountDiary();
    await user.pointer({ keys: '[MouseLeft]', target: screen.getByTestId('diary-backdrop') });
    expect(diaryBookStore.getState().writing).toBe(false);
  });

  it('the page is drawn without ink under the surface only once the surface is up', async () => {
    mountDiary();
    expect(diaryBookStore.getState().livePage).toBeNull();
    await vi.waitFor(
      () => {
        expect(diaryBookStore.getState().livePage).toBe(0);
      },
      { timeout: LIVE_AFTER_MS * 4 },
    );
    act(() => {
      anchorStore.getState().setStable(false); // the camera moves away
    });
    expect(diaryBookStore.getState().livePage).toBeNull();
  });

  it('keeps an unsent draft for when the reader comes back to the page', async () => {
    const user = userEvent.setup();
    mountDiary();
    await user.type(writeBox(), 'Who was the first');
    await user.keyboard('{Escape}');
    await vi.waitFor(() => {
      expect(screen.queryByTestId('diary-surface')).not.toBeInTheDocument();
    });
    act(() => {
      diaryBookStore.getState().startWriting();
    });
    expect(writeBox().value).toBe('Who was the first');
  });
});

describe('writing a question', () => {
  it('asks the server with the pages in view, and the question is in the accessible log at once', async () => {
    const stream = openStream();
    const { calls } = mountDiary({ routes: { [askPath]: () => stream.response } });
    await ask('Who founded it?');
    await vi.waitFor(() => {
      expect(calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).toEqual({ question: 'Who founded it?', context: { visiblePages: [3, 4] } });
    const log = screen.getByRole('log', { name: 'Conversation with the diary' });
    expect(log).toHaveTextContent('You wrote: Who founded it?');
    stream.end();
  });

  it('the question is on the page where the quill was, and the quill gives way while the diary writes', async () => {
    const stream = openStream();
    const { container } = mountDiary({ routes: { [askPath]: () => stream.response } });
    expect(writeBox()).toHaveFocus();
    await ask('Who?');
    expect(ink(container)).toContain('Who?');
    expect(container.querySelector('.pg-line[data-role="question"]')).toHaveAttribute('data-live');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    stream.send(
      { type: 'citations', citations: [], consulted: [] },
      done({ answer: 'Alaric.', grounded: true }),
    );
    stream.end();
    // When the diary has finished the answer stays in view; the quill is on the fresh page, reached by beginning to write.
    await screen.findByRole('button', { name: 'Show me the truth' });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    await userEvent.setup().keyboard('W');
    act(() => {
      diaryBookStore.getState().setMoving(false); // the book is still again (no scene here)
    });
    expect(writeBox().value).toBe('W');
    expect(writeBox()).toHaveFocus();
    expect(diaryBookStore.getState().page).toBe(1);
  });

  it('shows the real figures of the search while the diary listens', async () => {
    const stream = openStream();
    const { container } = mountDiary({ routes: { [askPath]: () => stream.response } });
    await ask('Who founded it?');
    stream.send({ type: 'status', stage: 'retrieving', elapsedMs: 3 });
    await settle();
    expect(screen.getByText('Searching the pages…')).toBeInTheDocument();
    stream.send(retrieval);
    await settle();
    expect(container.querySelector('.ink-listening__technical')).toHaveTextContent(
      'Searched 312 passages · pages 3, 7, 12',
    );
    stream.end();
  });

  it('says so, quietly, when the evidence was weak', async () => {
    const stream = openStream();
    const { container } = mountDiary({ routes: { [askPath]: () => stream.response } });
    await ask('Q');
    stream.send({ ...retrieval, evidence: 'weak' } as typeof retrieval);
    await settle();
    expect(container.querySelector('.ink-listening__technical')).toHaveTextContent('weak match');
    stream.end();
  });

  it("writes the reply as it streams; the done event's text replaces the streamed one; no marker is ever on the page", async () => {
    const stream = openStream();
    const { container } = mountDiary({ routes: { [askPath]: () => stream.response } });
    await ask('Who founded it?');
    stream.send({ type: 'token', text: 'It was founded in 1847 [S' });
    await vi.waitFor(() => {
      expect(answerInk(container)).toContain('It was founded in 1847');
    });
    expect(ink(container)).not.toContain('[S');
    stream.send(
      { type: 'citations', citations: [citation()], consulted: [{ page: 12 }] },
      done({ answer: 'It was founded in 1847 by a mapmaker [S1].' }),
    );
    stream.end();
    await vi.waitFor(() => {
      expect(answerInk(container)).toContain('by a mapmaker');
    });
    expect(ink(container)).not.toContain('[S1]');
    expect(chatStore.getState().askStatus).toBe('idle');
  });

  it('the finished answer is announced once, in the log, with the pages; the tokens never are', async () => {
    const stream = openStream();
    mountDiary({ routes: { [askPath]: () => stream.response } });
    await ask('Who founded it?');
    stream.send({ type: 'token', text: 'It was founded' });
    await settle();
    const log = screen.getByRole('log', { name: 'Conversation with the diary' });
    expect(log).not.toHaveTextContent('The diary wrote');
    stream.send({ type: 'citations', citations: [citation()], consulted: [] }, done());
    stream.end();
    await vi.waitFor(() => {
      expect(log).toHaveTextContent('The diary wrote: It was founded in 1847. Pages: Page 12');
    });
  });

  it('under the answer is a small handwritten link, "Show me the truth": a real button, there once the answer is written; the marginal notes are gone', async () => {
    const stream = openStream();
    const { container } = mountDiary({ routes: { [askPath]: () => stream.response } });
    await ask('Who founded it?');
    stream.send(
      { type: 'token', text: 'It was founded in 1847 [S1].' },
      { type: 'citations', citations: [citation()], consulted: [] },
      done(),
    );
    stream.end();
    const link = await screen.findByRole('button', { name: 'Show me the truth' });
    expect(link).toHaveClass('pg-note');
    expect(container.querySelectorAll('.pg-note')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /in the book/u })).not.toBeInTheDocument();
    // The pages themselves stay in the record for assistive technology.
    expect(screen.getByRole('log')).toHaveTextContent('Pages: Page 12');
  });

  it("pressing it starts the truth scene: the diary's line is written, then the book riffles", async () => {
    const stopReveal = startRevealEffect();
    const stream = openStream();
    mountDiary({ routes: { [askPath]: () => stream.response } });
    await ask('Who founded it?');
    stream.send({ type: 'citations', citations: [citation()], consulted: [] }, done());
    stream.end();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Show me the truth' }));
    expect(revealStore.getState().pages.map((entry) => entry.page)).toEqual([12]);
    stopReveal();
  });

  it('a refusal has no link to the truth: there is nothing to show', async () => {
    const stream = openStream();
    mountDiary({ routes: { [askPath]: () => stream.response } });
    await ask('What is the capital of Peru?');
    stream.send(
      { type: 'citations', citations: [], consulted: [] },
      done({ answer: 'No.', mode: 'not_found', grounded: false, refusedBy: 'evidence' }),
    );
    stream.end();
    await vi.waitFor(() => {
      expect(chatStore.getState().askStatus).toBe('idle');
    });
    expect(screen.queryByRole('button', { name: 'Show me the truth' })).not.toBeInTheDocument();
  });

  it("a refusal is faint ink in the diary's words, with no sources", async () => {
    const stream = openStream();
    const { container } = mountDiary({ routes: { [askPath]: () => stream.response } });
    await ask('What is the capital of Peru?');
    stream.send(
      { type: 'citations', citations: [], consulted: [{ page: 3 }] },
      done({
        answer: 'The diary could not find that answer within this manuscript.',
        mode: 'not_found',
        grounded: false,
        refusedBy: 'evidence',
      }),
    );
    stream.end();
    await vi.waitFor(() => {
      expect(answerInk(container)).toContain('The diary could not find that answer within this manuscript.');
    });
    expect(container.querySelectorAll('.pg-note')).toHaveLength(0);
  });

  it("a refusal is written in the diary's own words, in the script of the question, whatever the server's sentence or the interface language is", async () => {
    const stream = openStream();
    const { container } = mountDiary({ routes: { [askPath]: () => stream.response } });
    await ask('ما هو اللون المفضل لديك؟');
    stream.send(
      { type: 'citations', citations: [], consulted: [] },
      done({
        answer: 'I could not find this information in the document.',
        mode: 'not_found',
        grounded: false,
        refusedBy: 'model',
      }),
    );
    stream.end();
    await vi.waitFor(() => {
      expect(answerInk(container)).toContain('لم تجد المذكّرة هذه الإجابة في هذه المخطوطة');
    });
    expect(ink(container)).not.toContain('I could not find');
    expect(screen.getByRole('log')).toHaveTextContent('لم تجد المذكّرة هذه الإجابة');
  });

  it('never shows the raw refusal sentinel: if it arrives anyway the reply is a refusal', async () => {
    const stream = openStream();
    const { container } = mountDiary({ routes: { [askPath]: () => stream.response } });
    await ask('Q');
    stream.send({ type: 'token', text: 'NOT_IN_' }, { type: 'token', text: 'DOCUMENT' });
    await settle(120);
    expect(ink(container)).not.toContain('NOT_IN');
    stream.send(
      { type: 'citations', citations: [], consulted: [] },
      done({ answer: 'NOT_IN_DOCUMENT', grounded: false }),
    );
    stream.end();
    await vi.waitFor(() => {
      expect(answerInk(container)).toContain('The diary could not find that answer within this manuscript.');
    });
    expect(ink(container)).not.toContain('NOT_IN_DOCUMENT');
  });

  it('when no model can speak, the diary points at pages: a line, and the link to the truth', async () => {
    const stream = openStream();
    const { container } = mountDiary({ routes: { [askPath]: () => stream.response } });
    await ask('Who founded it?');
    stream.send(
      {
        type: 'citations',
        citations: [
          citation(),
          citation({ marker: 'S2', pageStart: 3, pageEnd: 4, sectionTitle: 'Overview', highlights: [] }),
        ],
        consulted: [],
      },
      done({ answer: '', mode: 'passages', grounded: true }),
    );
    stream.end();
    await vi.waitFor(() => {
      expect(answerInk(container)).toContain(
        'The diary cannot speak right now, but these pages seem to hold your answer:',
      );
    });
    expect(await screen.findByRole('button', { name: 'Show me the truth' })).toBeInTheDocument();
    expect(screen.getByRole('log')).toHaveTextContent('Pages: Page 12, Pages 3–4');
  });

  it('an answer that is not grounded says it is not certain and notes the pages it consulted, as consulted', async () => {
    const stream = openStream();
    const { container } = mountDiary({ routes: { [askPath]: () => stream.response } });
    await ask('Q');
    stream.send(
      { type: 'token', text: 'Perhaps it was 1847.' },
      { type: 'citations', citations: [], consulted: [{ page: 7 }, { page: 9 }] },
      done({ answer: 'Perhaps it was 1847.', grounded: false }),
    );
    stream.end();
    await vi.waitFor(() => {
      expect(answerInk(container)).toContain("I'm not certain. This is the closest thing the pages say.");
    });
    expect(await screen.findByRole('button', { name: 'Show me the truth' })).toBeInTheDocument();
  });

  it('a reply that was cut off keeps its text and sources and says the ink ran out', async () => {
    const stream = openStream();
    const { container } = mountDiary({ routes: { [askPath]: () => stream.response } });
    await ask('Q');
    stream.send(
      { type: 'citations', citations: [citation()], consulted: [] },
      done({ answer: 'It was founded in 18 [S1]', truncated: true }),
    );
    stream.end();
    await vi.waitFor(() => {
      expect(answerInk(container)).toContain('The ink ran out before the thought was finished.');
    });
    expect(await screen.findByRole('button', { name: 'Show me the truth' })).toBeInTheDocument();
  });

  it("an output block shows the diary's refusal and keeps the technical code under it", async () => {
    const stream = openStream();
    const { container } = mountDiary({ routes: { [askPath]: () => stream.response } });
    await ask('Q');
    stream.send(
      { type: 'error', error: { code: 'OUTPUT_BLOCKED', message: 'held back', detail: 'output guard' } },
      { type: 'citations', citations: [], consulted: [] },
      done({ answer: 'I held back my answer.', grounded: false }),
    );
    stream.end();
    await vi.waitFor(() => {
      expect(answerInk(container)).toContain('I held back my answer.');
    });
    expect(answerInk(container)).not.toContain("I'm not certain");
  });
});

describe('answers are inert text', () => {
  it('a malicious answer renders as text: no image, no link, no script, no handler', async () => {
    const stream = openStream();
    const { container } = mountDiary({ routes: { [askPath]: () => stream.response } });
    await ask('Q');
    const evil =
      '<img src=x onerror=alert(1)> ![x](http://evil.test/x.png) [click](javascript:alert(1)) <a href="http://evil.test">go</a> <script>alert(2)</script> **bold**';
    stream.send({ type: 'citations', citations: [], consulted: [] }, done({ answer: evil, grounded: true }));
    stream.end();
    await vi.waitFor(() => {
      expect(answerInk(container)).toContain('<img src=x onerror=alert(1)>');
    });
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(answerInk(container)).toContain('![x](http://evil.test/x.png)');
    // Bold is the one thing the formatter knows: its words are in a heavier face, as text.
    expect(container.querySelector('.pg-line[data-role="answer"]')?.innerHTML).not.toContain('<script');
  });
});

describe('Arabic', () => {
  it('an Arabic question and answer are laid out right to left, and the answer is written word by word', async () => {
    const stream = openStream();
    const { container } = mountDiary({
      routes: { [askPath]: () => stream.response },
      direction: 'rtl',
      language: 'ar',
    });
    await ask('من أسّس المدرسة؟');
    stream.send(
      { type: 'citations', citations: [citation()], consulted: [] },
      done({ answer: 'أسّسها الخرائطي ألاريك ثورنكويست عام ١٨٤٧ [S1].' }),
    );
    stream.end();
    await vi.waitFor(() => {
      expect(answerInk(container)).toContain('أسّسها الخرائطي');
    });
    const line = container.querySelector('.pg-line[data-role="answer"]');
    expect(line).toHaveAttribute('dir', 'rtl');
    const words = [...container.querySelectorAll('.pg-line[data-role="answer"] .ink-u')].map(
      (span) => span.textContent,
    );
    expect(words).toContain('أسّسها');
    expect(words).toContain('الخرائطي');
    // no span holds a part of an Arabic word
    for (const word of words) {
      if (/\p{Script=Arabic}/u.test(word)) expect(word.length).toBeGreaterThan(1);
    }
    expect(screen.getByRole('log')).toHaveAttribute('lang', 'ar');
    // notes: Eastern Arabic digits, in Arabic
    const note = await screen.findByRole('button', { name: 'أرني الحقيقة' });
    expect(note).toHaveTextContent('أرني الحقيقة');
  });

  it('an Arabic question gets Arabic everywhere, even when the interface is in English: the refusal, the notes and their names', async () => {
    const stream = openStream();
    const { container } = mountDiary({ routes: { [askPath]: () => stream.response }, language: 'en' });
    await ask('من أسّس المدرسة؟');
    stream.send(
      { type: 'citations', citations: [citation()], consulted: [] },
      done({ answer: 'أسّسها الخرائطي [S1].' }),
    );
    stream.end();
    const note = await screen.findByRole('button', { name: 'أرني الحقيقة' });
    expect(note).toHaveTextContent('أرني الحقيقة');
    expect(note).toHaveAttribute('lang', 'ar');
    expect(/[A-Za-z]/u.test(note.textContent)).toBe(false);
    expect(/[A-Za-z]/u.test(answerInk(container))).toBe(false);
  });

  it('an Arabic question that could not be answered says so in Arabic, with no English technical line', async () => {
    mountDiary({
      routes: { [askPath]: () => apiError(429, 'DIARY_BUSY', 'still writing') },
      direction: 'rtl',
      language: 'ar',
    });
    await ask('سؤال');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('المذكّرة ما زالت تكتب');
    expect(alert).not.toHaveTextContent('DIARY_BUSY');
  });
});

describe('when the question cannot be answered', () => {
  it('DIARY_BUSY before the stream: "The diary is still writing", with the code, and a way to ask again', async () => {
    mountDiary({ routes: { [askPath]: () => apiError(429, 'DIARY_BUSY', 'still writing') } });
    await ask('Q');
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('The diary is still writing.')).toBeInTheDocument();
    expect(alert).toHaveTextContent('DIARY_BUSY');
    expect(within(alert).getByRole('button', { name: 'Ask again' })).toBeInTheDocument();
  });

  it("a daily quota has its own line and shows the server's detail as the technical line", async () => {
    mountDiary({
      routes: { [askPath]: () => apiError(429, 'RATE_LIMITED', 'limit', 'daily quota reached') },
    });
    await ask('Q');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The diary has written all it can today. Its ink will return tomorrow.');
    expect(alert).toHaveTextContent('daily quota reached');
  });

  it('any other rate limit asks the reader to write a little slower', async () => {
    mountDiary({
      routes: { [askPath]: () => apiError(429, 'RATE_LIMITED', 'limit', 'retry after 7 seconds') },
    });
    await ask('Q');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Write a little slower. The ink hasn't dried yet.");
  });

  it('a broken connection: "The connection to the archive was interrupted." and a retry that asks again', async () => {
    const first = openStream();
    const second = openStream();
    let attempt = 0;
    const { calls, container } = mountDiary({
      routes: {
        [askPath]: () => {
          attempt += 1;
          return attempt === 1 ? first.response : second.response;
        },
      },
    });
    await ask('Who founded it?');
    first.send({ type: 'status', stage: 'retrieving', elapsedMs: 1 });
    await settle();
    first.break();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The connection to the archive was interrupted.');
    await userEvent.setup().click(within(alert).getByRole('button', { name: 'Ask again' }));
    await vi.waitFor(() => {
      expect(calls.filter((call) => call.method === 'POST')).toHaveLength(2);
    });
    expect(calls.filter((call) => call.method === 'POST')[1]?.body).toMatchObject({
      question: 'Who founded it?',
    });
    second.send(
      { type: 'citations', citations: [], consulted: [] },
      done({ answer: 'Second try.', grounded: true }),
    );
    second.end();
    await vi.waitFor(() => {
      expect(answerInk(container)).toContain('Second try');
    });
  });

  it("an error event in the stream shows the diary's line and the server's detail", async () => {
    const stream = openStream();
    mountDiary({ routes: { [askPath]: () => stream.response } });
    await ask('Q');
    stream.send({
      type: 'error',
      error: { code: 'LLM_FAILED', message: 'upstream 502', detail: 'the model stopped' },
    });
    stream.end();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The diary lost its train of thought. Ask again.');
    expect(alert).toHaveTextContent('the model stopped');
  });
});

describe('the reveal phrase', () => {
  it('with nothing answered yet, writes the "nothing to show" line on the page and never reaches the server', async () => {
    const { calls, container } = mountDiary({
      routes: { [askPath]: () => apiError(500, 'INTERNAL', 'must not be called') },
    });
    await ask('But I can show you...');
    expect(experienceStore.getState().phase).toBe('manuscript');
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    expect(chatStore.getState().turn?.localText).toContain('nothing to show you yet');
    await vi.waitFor(() => {
      expect(ink(container)).toContain('nothing to show you yet');
    });
  });
});

describe('the flyleaf, before a manuscript', () => {
  it('has no quill button of its own: the upload page carries only the two upload controls', () => {
    mountDiary({ phase: 'awaiting', idle: true });
    expect(screen.queryByTestId('diary-surface')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Write in the diary' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('awaiting-quill')).not.toBeInTheDocument();
  });

  it('the diary answers in its own scripted voice, cycling by attempt, and asks nothing of the server', async () => {
    const { calls, container } = mountDiary({ phase: 'awaiting' });
    await ask('Hello?');
    await vi.waitFor(() => {
      expect(ink(container)).toContain('I have nothing to remember yet. Give me a manuscript first.');
    });
    await ask('Anyone there?');
    await vi.waitFor(() => {
      expect(ink(container)).toContain('Your words sink into blank paper');
    });
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    expect(screen.getByRole('log')).toHaveTextContent('You wrote: Anyone there?');
  });

  it('answers an Arabic question in Arabic, and the secret phrase with "nothing to show you yet"', async () => {
    const { container } = mountDiary({ phase: 'awaiting' });
    await ask('مرحبا؟');
    await vi.waitFor(() => {
      expect(ink(container)).toMatch(/\p{Script=Arabic}{3}/u);
    });
    expect(ink(container)).not.toContain('nothing to remember');
    await ask('Reveal the secrets.');
    await vi.waitFor(() => {
      expect(ink(container)).toContain('I have nothing to show you yet.');
    });
    expect(experienceStore.getState().phase).toBe('awaiting');
  });
});

describe('the history', () => {
  const message = (id: string, role: 'user' | 'assistant', content: string, extra = {}) => ({
    id: `00000000-0000-4000-8000-00000000000${id.slice(-1)}`,
    role,
    kind: role === 'user' ? ('question' as const) : ('answer' as const),
    content,
    citations: [],
    createdAt: '2026-10-01T10:00:00.000Z',
    ...extra,
  });

  it('comes back from the server as dried ink on the diary page: real text for assistive technology, and working notes', async () => {
    const { container } = mountDiary({
      conversation: {
        documentId: DOCUMENT_ID,
        messages: [
          message('a1', 'user', 'Who founded it?'),
          message('a2', 'assistant', 'Alaric Thornquist [S1].', {
            mode: 'answer',
            grounded: true,
            citations: [citation()],
          }),
        ],
      },
    });
    await vi.waitFor(() => {
      expect(ink(container)).toContain('Alaric Thornquist');
    });
    expect(container.querySelector('.pg-line[data-role="question"]')).toHaveAttribute('data-state', 'dried');
    expect(ink(container)).not.toContain('[S1]');
    expect(screen.getByRole('button', { name: 'Show me the truth' })).toBeInTheDocument();
    // The page's ink is a picture of the words; the words themselves are in the record for assistive technology.
    expect(container.querySelector('.pg-lines')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('diary-history')).toHaveTextContent('You wrote: Who founded it?');
    expect(screen.getByTestId('diary-history')).toHaveTextContent('The diary wrote: Alaric Thornquist.');
    expect(diaryBookStore.getState().leaves).toBe(2); // the answer's page and the fresh one
  });

  it('"Clear the conversation" is in the diary menu: it asks first, then deletes it on the server and empties the page', async () => {
    const user = userEvent.setup();
    const remove = vi.fn(() => new Response(null, { status: 204 }));
    const { container } = mountDiary({
      conversation: {
        documentId: DOCUMENT_ID,
        messages: [
          message('a1', 'user', 'Who?'),
          message('a2', 'assistant', 'Alaric.', { mode: 'answer', grounded: true }),
        ],
      },
      routes: { [`DELETE /api/documents/${DOCUMENT_ID}/conversation`]: remove },
    });
    await vi.waitFor(() => {
      expect(ink(container)).toContain('Alaric.');
    });
    await user.click(screen.getByRole('button', { name: 'Diary menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Clear the conversation' }));
    expect(remove).not.toHaveBeenCalled(); // it asks first
    expect(screen.getByText('Forget this conversation?')).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Clear it' }));
    await vi.waitFor(() => {
      expect(remove).toHaveBeenCalledTimes(1);
    });
    expect(ink(container)).not.toContain('Alaric.');
    expect(diaryBookStore.getState().leaves).toBe(1); // only the page being written on is left
  });

  it('the focus goes with the menu: onto "Not now" when it asks, and back to its button when it is closed', async () => {
    const user = userEvent.setup();
    const { container } = mountDiary({
      conversation: {
        documentId: DOCUMENT_ID,
        messages: [
          message('a1', 'user', 'Who?'),
          message('a2', 'assistant', 'Alaric.', { mode: 'answer', grounded: true }),
        ],
      },
    });
    await vi.waitFor(() => {
      expect(ink(container)).toContain('Alaric.');
    });
    const toggle = screen.getByRole('button', { name: 'Diary menu' });
    await user.click(toggle);
    await user.click(screen.getByRole('menuitem', { name: 'Clear the conversation' }));
    expect(screen.getByRole('menuitem', { name: 'Not now' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.queryByText('Forget this conversation?')).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
  });

  it('the earlier answer dries when the next question is written', async () => {
    const first = openStream();
    const second = openStream();
    let n = 0;
    const { container } = mountDiary({
      routes: { [askPath]: () => (++n === 1 ? first.response : second.response) },
    });
    await ask('One?');
    first.send({ type: 'citations', citations: [], consulted: [] }, done({ answer: 'First answer.' }));
    first.end();
    await vi.waitFor(() => {
      expect(answerInk(container)).toContain('First answer');
    });
    // Beginning to write turns the book one leaf to the fresh page, and the first letter goes with the reader.
    await screen.findByRole('button', { name: 'Show me the truth' });
    await userEvent.setup().keyboard('x');
    act(() => {
      diaryBookStore.getState().setMoving(false);
    });
    await userEvent.setup().clear(screen.getByRole('textbox'));
    await ask('Two?');
    // The second question is written on a fresh page; the first exchange is dried ink on the page before.
    await vi.waitFor(() => {
      expect(container.querySelectorAll('.pg-line[data-state="sinking"]')).toHaveLength(1);
    });
    expect(diaryBookStore.getState().page).toBe(1);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Earlier page of the diary' }));
    expect(container.querySelectorAll('.pg-line[data-state="dried"]')).toHaveLength(1);
    expect(ink(container)).toContain('First answer');
    second.end();
  });
});

describe('what to do next', () => {
  it('under a written answer: a faint handwritten line "Write your next question…" and a blinking caret; typing goes on to the next page', async () => {
    const stream = openStream();
    const { container } = mountDiary({ routes: { [askPath]: () => stream.response } });
    expect(container.querySelector('.pg-hint')).toBeNull();
    await ask('Who?');
    stream.send(
      { type: 'citations', citations: [], consulted: [] },
      done({ answer: 'Alaric.', grounded: true }),
    );
    stream.end();
    await vi.waitFor(() => {
      expect(container.querySelector('.pg-hint')).toHaveTextContent('Write your next question…');
    });
    expect(container.querySelector('.pg-hint .pg-caret')).toBeInTheDocument();
  });

  it('the first page is headed, and the first question is written under the heading', () => {
    const { container } = mountDiary();
    expect(container.querySelector('.pg-line[data-role="heading"]')).toBeInTheDocument();
    expect(
      [...container.querySelectorAll('.pg-line[data-role="heading"]')]
        .map((line) => line.textContent)
        .join(' ')
        .replace(/\s+/gu, ' '),
    ).toContain("It's the time for you to gain");
  });
});

describe('the diary has more than one page', () => {
  const long = (n: number): string =>
    Array.from({ length: n }, (_, i) => `Sentence number ${String(i)} of a long and careful answer.`).join(
      ' ',
    );

  it('a long answer runs onto the next page: a leaf is bound for it and the book turns to where the pen is', async () => {
    const stream = openStream();
    const { container } = mountDiary({ routes: { [askPath]: () => stream.response } });
    await ask('Tell me everything.');
    stream.send(
      { type: 'citations', citations: [], consulted: [] },
      done({ answer: long(60), grounded: true }),
    );
    stream.end();
    await vi.waitFor(() => {
      expect(diaryBookStore.getState().leaves).toBeGreaterThan(1);
    });
    await vi.waitFor(() => {
      expect(diaryBookStore.getState().page).toBeGreaterThan(0);
    });
    // The answer stays in view (no quill beside it); the page's controls name where the reader is.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    const folio = container.querySelector('.pg-folio');
    expect(folio?.textContent).toMatch(/Diary page \d+ of \d+/u);
  });

  it('the page controls turn to the earlier and the later pages, and stop at the first and the last', async () => {
    const user = userEvent.setup();
    const stream = openStream();
    const { container } = mountDiary({ routes: { [askPath]: () => stream.response } });
    await ask('Tell me everything.');
    stream.send(
      { type: 'citations', citations: [], consulted: [] },
      done({ answer: long(60), grounded: true }),
    );
    stream.end();
    const earlier = await screen.findByRole('button', { name: 'Earlier page of the diary' });
    const later = screen.getByRole('button', { name: 'Later page of the diary' });
    // The pen ends on the last page of the answer; the fresh page for the next question is one leaf on.
    await vi.waitFor(() => {
      expect(diaryBookStore.getState().page).toBe(diaryBookStore.getState().leaves - 2);
    });
    expect(later).toBeEnabled();
    await user.click(later);
    expect(diaryBookStore.getState().page).toBe(diaryBookStore.getState().leaves - 1);
    expect(await screen.findByRole('textbox')).toBeInTheDocument();
    expect(later).toBeDisabled();
    await user.click(earlier);
    // Back to the first page (the question is written on it).
    while (diaryBookStore.getState().page > 0) {
      await user.click(screen.getByRole('button', { name: 'Earlier page of the diary' }));
    }
    expect(diaryBookStore.getState().page).toBe(0);
    expect(screen.getByRole('button', { name: 'Earlier page of the diary' })).toBeDisabled();
    expect(ink(container)).toContain('Tell me everything.');
    // No quill on a page that is not the last: the question goes on the last one.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('turning to another page lets go of the page it lay on, so the book can turn', async () => {
    const user = userEvent.setup();
    const stream = openStream();
    mountDiary({ routes: { [askPath]: () => stream.response } });
    await ask('Tell me everything.');
    stream.send(
      { type: 'citations', citations: [], consulted: [] },
      done({ answer: long(60), grounded: true }),
    );
    stream.end();
    await user.click(await screen.findByRole('button', { name: 'Earlier page of the diary' }));
    expect(diaryBookStore.getState().livePage).toBeNull();
    expect(diaryBookStore.getState().moving).toBe(true);
  });

  it("the arrow keys turn the diary's pages, not the manuscript's, while the reader writes", async () => {
    const user = userEvent.setup();
    const stream = openStream();
    mountDiary({ routes: { [askPath]: () => stream.response } });
    await ask('Tell me everything.');
    stream.send(
      { type: 'citations', citations: [], consulted: [] },
      done({ answer: long(60), grounded: true }),
    );
    stream.end();
    await vi.waitFor(() => {
      expect(diaryBookStore.getState().page).toBeGreaterThan(0);
    });
    const before = readerStore.getState().spread;
    await user.click(screen.getByRole('button', { name: 'Earlier page of the diary' }));
    const page = diaryBookStore.getState().page;
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard('{ArrowRight}');
    expect(readerStore.getState().spread).toBe(before);
    expect(diaryBookStore.getState().page).toBe(page + 1);
  });
});

describe("the quill button of the reader's bar", () => {
  it('dives onto the diary page and, pressed again, steps back', async () => {
    const { WriteToggle } = await import('../../src/ui/diary/WriteToggle');
    const { render } = await import('@testing-library/react');
    mountDiary({ idle: true });
    render(<WriteToggle />);
    const toggle = screen.getByRole('button', { name: 'Write in the diary', pressed: false });
    await userEvent.setup().click(toggle);
    expect(diaryBookStore.getState().writing).toBe(true);
    expect(screen.getByRole('button', { name: 'Write in the diary', pressed: true })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Write in the diary', pressed: true }));
    expect(diaryBookStore.getState().writing).toBe(false);
  });
});
