import type { Citation, Message } from '@enchanted/shared';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExperienceShell } from '../../src/components/ExperienceShell';
import { pageImageService } from '../../src/pdf/pageImageService';
import { chatStore } from '../../src/state/chatStore';
import { confirmStore } from '../../src/state/confirmStore';
import { documentStore } from '../../src/state/documentStore';
import { experienceStore, initialExperienceState, type Phase } from '../../src/state/experience';
import { settingsStore } from '../../src/state/settingsStore';
import { SkipLink } from '../../src/ui/fallback/SkipLink';
import { SimpleView } from '../../src/ui/fallback/SimpleView';
import { resetStores } from '../components/helpers';

const NO_WEBGL = () => ({ supported: false, reason: 'no webgl' });

const citation = (over: Partial<Citation> = {}): Citation => ({
  marker: 'S1',
  chunkId: '5d0a3d1c-7f31-4c1e-8f7e-0d9d3a9d6b11',
  pageStart: 12,
  pageEnd: 12,
  sectionTitle: 'The Founding',
  snippet: 'x',
  language: 'en',
  direction: 'ltr',
  highlights: [{ page: 12, rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.05 }] }],
  ...over,
});

const message = (
  id: number,
  role: 'user' | 'assistant',
  content: string,
  extra: Partial<Message> = {},
): Message => ({
  id: `00000000-0000-4000-8000-0000000000${String(id).padStart(2, '0')}`,
  role,
  kind: role === 'user' ? 'question' : 'answer',
  content,
  citations: [],
  createdAt: '2026-10-01T10:00:00.000Z',
  ...extra,
});

function enter(phase: Phase, extra: Partial<ReturnType<typeof experienceStore.getState>> = {}): void {
  experienceStore.setState({ ...initialExperienceState, phase, sessionChecked: true, ...extra });
}

async function violations(container: Element) {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  return results.violations.map((violation) => `${violation.id}: ${violation.help}`);
}

beforeEach(() => {
  resetStores();
  chatStore.getState().reset();
  documentStore.getState().reset();
  confirmStore.getState().dismiss();
  vi.restoreAllMocks();
});

describe('the presenter contract of the simple view', () => {
  it.each([
    ['opening', 'awaiting'],
    ['unveiling', 'manuscript'],
    ['closing', 'discovery'],
  ] as const)('mounted mid-%s it ends the phase at once (-> %s)', (phase, next) => {
    enter(phase);
    render(<SimpleView />);
    expect(experienceStore.getState().phase).toBe(next);
  });

  it('a reveal that was asked for ends, and its memory is dismissed: the conversation is back', () => {
    enter('revealing', { documentId: 'x' });
    render(<SimpleView />);
    expect(experienceStore.getState().phase).toBe('manuscript');
  });

  it('does not end a phase twice for the epoch it started in', () => {
    enter('unveiling');
    const { rerender } = render(<SimpleView />);
    const { epoch } = experienceStore.getState();
    rerender(<SimpleView />);
    expect(experienceStore.getState().epoch).toBe(epoch);
  });
});

describe('the welcome', () => {
  it('shows the title and one button; the button opens the diary, which then waits for a manuscript', async () => {
    enter('discovery');
    render(<SimpleView />);
    const start = screen.getByRole('button', { name: 'Start revealing the secrets' });
    expect(screen.getAllByRole('button')).toHaveLength(1);
    await userEvent.click(start);
    expect(experienceStore.getState().phase).toBe('awaiting');
  });

  it('takes the focus when it comes back after the diary was closed, not at the first load', () => {
    enter('discovery');
    const first = render(<SimpleView />);
    expect(screen.getByRole('button', { name: 'Start revealing the secrets' })).not.toHaveFocus();
    first.unmount();
    enter('discovery', { epoch: 4 });
    render(<SimpleView />);
    expect(screen.getByRole('button', { name: 'Start revealing the secrets' })).toHaveFocus();
  });

  it('puts the focus in the field when the conversation opens', () => {
    enter('manuscript', { documentId: 'x', epoch: 2 });
    render(<SimpleView />);
    expect(screen.getByRole('textbox', { name: 'Write to the diary' })).toHaveFocus();
  });

  it('waits for the session check before it can be pressed', () => {
    enter('discovery', { sessionChecked: false });
    render(<SimpleView />);
    expect(screen.getByRole('button', { name: 'Start revealing the secrets' })).toBeDisabled();
  });

  it('has no axe violations', async () => {
    enter('discovery');
    const { container } = render(<SimpleView />);
    expect(await violations(container)).toEqual([]);
  });
});

describe('the conversation', () => {
  function converse(): void {
    chatStore.getState().setMessages([
      message(1, 'user', 'Who founded it?'),
      message(2, 'assistant', 'It was founded in 1847 [S1].', {
        mode: 'answer',
        grounded: true,
        citations: [citation()],
      }),
      message(3, 'user', 'من أسّس المدرسة؟'),
      message(4, 'assistant', 'أسّسها الأخوان في عام ١٨٤٧.', {
        mode: 'answer',
        grounded: true,
        citations: [citation()],
      }),
    ]);
    enter('manuscript', { documentId: 'x' });
  }

  it('has one parchment card per exchange: the question, the answer, one link to the truth', () => {
    converse();
    render(<SimpleView />);
    const cards = screen.getAllByTestId('exchange-card');
    expect(cards).toHaveLength(2);
    const first = within(cards[0]!);
    expect(first.getByText('Who founded it?')).toBeInTheDocument();
    expect(first.getByText('It was founded in 1847.')).toBeInTheDocument();
    expect(first.getAllByRole('button')).toHaveLength(1);
    expect(first.getByRole('button', { name: 'Show me the truth' })).toBeInTheDocument();
  });

  it('writes an Arabic question and answer with their own language, direction and Arabic link', () => {
    converse();
    render(<SimpleView />);
    const arabic = within(screen.getAllByTestId('exchange-card')[1]!);
    const question = arabic.getByText('من أسّس المدرسة؟');
    expect(question).toHaveAttribute('lang', 'ar');
    expect(question).toHaveAttribute('dir', 'rtl');
    expect(arabic.getByText('أسّسها الأخوان في عام ١٨٤٧.')).toHaveAttribute('dir', 'rtl');
    expect(arabic.getByRole('button', { name: 'أرني الحقيقة' })).toBeInTheDocument();
  });

  it('keeps ONE polite log of the conversation and no other live region in the cards', () => {
    converse();
    const { container } = render(<SimpleView />);
    const log = screen.getByRole('log');
    expect(log).toHaveAttribute('aria-live', 'polite');
    expect(log).toHaveTextContent('You wrote: Who founded it?');
    expect(log).toHaveTextContent('The diary wrote: It was founded in 1847.');
    expect(container.querySelectorAll('[aria-live]')).toHaveLength(1);
  });

  it('commits a question with Enter, keeps Shift+Enter and IME composition for the field', async () => {
    enter('manuscript', { documentId: 'x' });
    render(<SimpleView />);
    const field = screen.getByRole('textbox', { name: 'Write to the diary' });
    await userEvent.type(field, 'Hello{Shift>}{Enter}{/Shift}there');
    expect(chatStore.getState().turn).toBeNull();
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true });
    expect(chatStore.getState().turn).toBeNull();
    await userEvent.type(field, '{Enter}');
    expect(chatStore.getState().turn?.question).toBe('Hello\nthere');
    expect(field).toHaveValue('');
  });

  it('shows the cited page with its passage when "Show me the truth" is pressed, and gives the focus back', async () => {
    converse();
    const canvas = document.createElement('canvas');
    const enqueue = vi.spyOn(pageImageService, 'enqueue').mockReturnValue({
      promise: Promise.resolve(canvas),
      setPriority: () => undefined,
      cancel: () => undefined,
    });
    render(<SimpleView />);
    const link = within(screen.getAllByTestId('exchange-card')[0]!).getByRole('button', {
      name: 'Show me the truth',
    });
    link.focus();
    await userEvent.click(link);
    const dialog = await screen.findByRole('dialog', { name: 'Show me the truth' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByText('Let me show you the truth…')).toBeInTheDocument();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ page: 12, highlight: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.05 }] }),
    );
    const back = within(dialog).getByRole('button', { name: 'Return to the diary' });
    expect(back).toHaveFocus();
    // the focus stays inside
    await userEvent.tab();
    expect(back).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(link).toHaveFocus();
  });

  it('says so when the pages cannot be drawn', async () => {
    converse();
    vi.spyOn(pageImageService, 'enqueue').mockImplementation(() => ({
      promise: Promise.reject(new Error('no pdf')),
      setPriority: () => undefined,
      cancel: () => undefined,
    }));
    render(<SimpleView />);
    await userEvent.click(
      within(screen.getAllByTestId('exchange-card')[0]!).getByRole('button', { name: 'Show me the truth' }),
    );
    expect(await screen.findByText(/cannot be shown|not shown|cannot/i)).toBeInTheDocument();
  });

  it('offers another manuscript or closes the diary only by asking first', async () => {
    converse();
    render(<SimpleView />);
    await userEvent.click(screen.getByRole('button', { name: 'Close this diary' }));
    expect(confirmStore.getState().request).toEqual({ kind: 'close' });
  });

  it('has no axe violations (English and Arabic interface)', async () => {
    converse();
    const { container, unmount } = render(<SimpleView />);
    expect(await violations(container)).toEqual([]);
    unmount();
    settingsStore.getState().setUiLanguage('ar');
    const arabic = render(<SimpleView />);
    expect(await violations(arabic.container)).toEqual([]);
  });
});

describe('Arabic means Arabic', () => {
  it.each<Phase>(['discovery', 'manuscript'])(
    'the %s chrome of the Arabic interface has no Latin letters',
    (phase) => {
      settingsStore.getState().setUiLanguage('ar');
      chatStore.getState().setMessages([
        message(1, 'user', 'من أسّس المدرسة؟'),
        message(2, 'assistant', 'أسّسها الأخوان.', {
          mode: 'answer',
          grounded: true,
          citations: [citation()],
        }),
      ]);
      enter(phase, { documentId: 'x' });
      render(<SimpleView />);
      const text = screen.getByTestId('simple-view').textContent;
      expect(text).not.toMatch(/[A-Za-z]/u);
    },
  );
});

describe('inside the stage', () => {
  it('replaces the closed-diary silhouette: the welcome shows, the page controls do not', () => {
    render(<ExperienceShell detectWebGL={NO_WEBGL} />);
    expect(screen.getByTestId('simple-welcome')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Page controls' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Go to page|Read closely/ })).not.toBeInTheDocument();
  });

  it('while a manuscript is open there is no page browsing in the simple view', () => {
    enter('manuscript', { documentId: 'x' });
    render(<ExperienceShell detectWebGL={NO_WEBGL} />);
    expect(
      screen.queryByRole('button', { name: /Go to page|Read closely|Next page|Previous page/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Write to the diary' })).toBeInTheDocument();
  });

  it('the skip link moves the focus to the main landmark', async () => {
    render(
      <>
        <SkipLink />
        <ExperienceShell detectWebGL={NO_WEBGL} />
      </>,
    );
    await userEvent.tab();
    const link = screen.getByRole('link', { name: 'Skip to the diary' });
    expect(link).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('the whole stage in the simple view has no axe violations in the welcome and the conversation', async () => {
    const welcome = render(<ExperienceShell detectWebGL={NO_WEBGL} />);
    expect(await violations(welcome.container)).toEqual([]);
    act(() => {
      welcome.unmount();
    });
    enter('manuscript', { documentId: 'x' });
    const talking = render(<ExperienceShell detectWebGL={NO_WEBGL} />);
    expect(await violations(talking.container)).toEqual([]);
  });
});
