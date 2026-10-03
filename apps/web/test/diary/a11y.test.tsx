import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOCUMENT_ID } from '../fixtures';
import { citation, done, mountDiary, openStream, unmountDiary } from './harness';

/* The diary's page checked by axe-core (jsdom has no layout: colour contrast is measured in the browser run instead). */
async function violations(container: Element): Promise<string[]> {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  return results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} (${violation.nodes.map((node) => node.html.slice(0, 90)).join(' | ')})`,
  );
}

afterEach(() => {
  unmountDiary();
});

describe('the diary page: accessibility floor', () => {
  it('the page, with a finished answer and its notes, has no axe violations (English)', async () => {
    const stream = openStream();
    const { container } = mountDiary({
      routes: { [`POST /api/documents/${DOCUMENT_ID}/ask`]: () => stream.response },
    });
    await userEvent.setup().type(screen.getByRole('textbox'), 'Who founded it?{Enter}');
    stream.send(
      { type: 'citations', citations: [citation()], consulted: [] },
      done({ answer: 'It was founded in 1847 [S1].' }),
    );
    stream.end();
    await screen.findByRole('button', { name: 'Show me the truth' });
    expect(await violations(container)).toEqual([]);
  });

  it('the page in Arabic has no axe violations', async () => {
    const { container } = mountDiary({ language: 'ar', direction: 'rtl' });
    expect(await violations(container)).toEqual([]);
  });

  it('the page with earlier exchanges and several pages has no axe violations', async () => {
    const { container } = mountDiary({
      conversation: {
        documentId: DOCUMENT_ID,
        messages: [
          {
            id: '00000000-0000-4000-8000-000000000001',
            role: 'user',
            kind: 'question',
            content: 'Who founded it?',
            citations: [],
            createdAt: '2026-10-01T10:00:00.000Z',
          },
          {
            id: '00000000-0000-4000-8000-000000000002',
            role: 'assistant',
            kind: 'answer',
            content: Array.from({ length: 70 }, (_, i) => `Sentence ${String(i)} of a long answer.`).join(
              ' ',
            ),
            mode: 'answer',
            grounded: true,
            citations: [citation()],
            createdAt: '2026-10-01T10:00:00.000Z',
          },
        ],
      },
    });
    await screen.findByRole('button', { name: 'Earlier page of the diary' });
    expect(await violations(container)).toEqual([]);
  });

  it('the flyleaf page has no axe violations, and the quill button on the closed flyleaf has none', async () => {
    const { container } = mountDiary({ phase: 'awaiting' });
    expect(await violations(container)).toEqual([]);
    unmountDiary();
    const idle = mountDiary({ phase: 'awaiting', idle: true });
    expect(await violations(idle.container)).toEqual([]);
  });

  it('the textarea has an accessible name; the conversation log is polite; the ink layer is hidden because the log speaks for it', async () => {
    const stream = openStream();
    const { container } = mountDiary({
      routes: { [`POST /api/documents/${DOCUMENT_ID}/ask`]: () => stream.response },
    });
    expect(screen.getByRole('textbox', { name: 'Write to the diary' })).toBeInTheDocument();
    await userEvent.setup().type(screen.getByRole('textbox'), 'Q{Enter}');
    stream.send({ type: 'token', text: 'Some words.' });
    await vi.waitFor(() => {
      expect(container.querySelector('.pg-line[data-role="answer"]')).toBeInTheDocument();
    });
    expect(screen.getByRole('log')).toHaveAttribute('aria-live', 'polite');
    // The page's ink is a picture of the words: hidden while the log speaks for it.
    expect(container.querySelector('.pg-lines')).toHaveAttribute('aria-hidden', 'true');
    stream.end();
  });

  it('every control is a real button or field with a name', () => {
    const stream = openStream();
    mountDiary({ routes: { [`POST /api/documents/${DOCUMENT_ID}/ask`]: () => stream.response } });
    for (const button of screen.getAllByRole('button')) {
      expect(button.tagName).toBe('BUTTON');
      expect(button.getAttribute('aria-label') ?? button.textContent).toBeTruthy();
    }
    stream.end();
  });
});
