import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { diaryBookStore } from '../../src/state/diaryBook';
import { DOCUMENT_ID } from '../fixtures';
import { apiError } from '../helpers/network';
import { citation, done, mountDiary, openStream, unmountDiary } from './harness';

/*
 * "Arabic means Arabic" on the page (global section T.2): in the Arabic interface, and for a question written in Arabic whatever
 * the interface is, the reply, the refusal, the notes, the failure lines and the page's own controls are Arabic. The only things
 * that stay Latin are the technical codes (their own line, in the ordinary face) and a file format's name.
 */

afterEach(() => {
  unmountDiary();
});

const askPath = `POST /api/documents/${DOCUMENT_ID}/ask`;
const LATIN = /\p{Script=Latin}/u;

/** Everything a reader (or a screen reader) is given in the surface, but for the technical lines. */
function copyOf(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  for (const technical of clone.querySelectorAll('.technical, .technical-inline')) technical.remove();
  return clone.textContent;
}

async function ask(text: string): Promise<void> {
  await userEvent.setup().type(screen.getByRole('textbox'), `${text}{Enter}`);
}

describe('the Arabic states of the page have no English in them', () => {
  it('the empty page: the quill, the controls, the log', () => {
    const { container } = mountDiary({ language: 'ar', direction: 'rtl' });
    expect(copyOf(container)).not.toMatch(LATIN);
    expect(screen.getByRole('textbox', { name: 'اكتب إلى المذكّرة' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ابتعد عن الصفحة' })).toBeInTheDocument();
  });

  it('an answered question: the reply, the notes in the margin and the log', async () => {
    const stream = openStream();
    const { container } = mountDiary({
      language: 'ar',
      direction: 'rtl',
      routes: { [askPath]: () => stream.response },
    });
    await ask('من أسّس المدرسة؟');
    stream.send(
      {
        type: 'citations',
        citations: [citation(), citation({ marker: 'S2', pageStart: 3, pageEnd: 4, highlights: [] })],
        consulted: [],
      },
      done({ answer: 'أسّسها الخرائطي ألاريك ثورنكويست عام ١٨٤٧ [S1] [S2].' }),
    );
    stream.end();
    await screen.findByRole('button', { name: 'أرني الحقيقة' });
    expect(screen.getByRole('button', { name: 'أرني الحقيقة' })).toBeInTheDocument();
    expect(copyOf(container)).not.toMatch(LATIN);
  });

  it("a refusal, and an answer that is not certain: the diary's own lines", async () => {
    const stream = openStream();
    const { container } = mountDiary({
      language: 'ar',
      direction: 'rtl',
      routes: { [askPath]: () => stream.response },
    });
    await ask('ما عاصمة بيرو؟');
    stream.send(
      { type: 'citations', citations: [], consulted: [{ page: 3 }] },
      done({
        answer: 'The diary could not find that answer.',
        mode: 'not_found',
        grounded: false,
        refusedBy: 'evidence',
      }),
    );
    stream.end();
    await vi.waitFor(() => {
      expect(container.querySelector('.pg-line[data-role="answer"]')).toBeInTheDocument();
    });
    expect(copyOf(container)).not.toMatch(LATIN);
  });

  it('a question that could not be answered: the line, and the way to ask again', async () => {
    mountDiary({
      language: 'ar',
      direction: 'rtl',
      routes: { [askPath]: () => apiError(429, 'RATE_LIMITED', 'limit', 'daily quota reached') },
    });
    await ask('سؤال');
    const alert = await screen.findByRole('alert');
    expect(copyOf(alert)).not.toMatch(LATIN);
    expect(alert).not.toHaveTextContent('daily quota reached'); // the server's English is not shown
  });

  it('the diary listening, with the real figures of its search', async () => {
    const stream = openStream();
    const { container } = mountDiary({
      language: 'ar',
      direction: 'rtl',
      routes: { [askPath]: () => stream.response },
    });
    await ask('سؤال');
    stream.send({ type: 'status', stage: 'retrieving', elapsedMs: 3 });
    await vi.waitFor(() => {
      expect(container.querySelector('.ink-listening')).toBeInTheDocument();
    });
    expect(copyOf(container)).not.toMatch(LATIN);
    stream.end();
  });

  it('the flyleaf: the scripted lines', async () => {
    const view = mountDiary({ phase: 'awaiting', idle: true, language: 'ar', direction: 'rtl' });
    expect(copyOf(view.container)).not.toMatch(LATIN);
    act(() => {
      diaryBookStore.getState().startWriting();
    });
    await ask('مرحبا؟');
    await vi.waitFor(() => {
      expect(view.container.querySelector('.pg-line[data-role="answer"]')).toBeInTheDocument();
    });
    expect(copyOf(view.container)).not.toMatch(LATIN);
  });

  it('an Arabic question in the English interface is answered in Arabic: the refusal, the notes, the failure line', async () => {
    const stream = openStream();
    const { container } = mountDiary({ language: 'en', routes: { [askPath]: () => stream.response } });
    await ask('ما عاصمة بيرو؟');
    stream.send(
      { type: 'citations', citations: [], consulted: [] },
      done({ answer: 'I could not find it.', mode: 'not_found', grounded: false, refusedBy: 'model' }),
    );
    stream.end();
    await vi.waitFor(() => {
      expect(container.querySelector('.pg-line[data-role="answer"]')).toBeInTheDocument();
    });
    // (The page's heading is the interface's: English here.)
    const lines = [...container.querySelectorAll('.pg-line:not([data-role="heading"])')]
      .map((line) => line.textContent)
      .join(' ');
    expect(lines).not.toMatch(LATIN);
  });
});
