import { QUESTION_MAX_CHARS } from '@enchanted/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settingsStore } from '../../src/state/settingsStore';
import { QuillInput } from '../../src/ui/diary/QuillInput';
import { resetStores } from '../components/helpers';

beforeEach(() => {
  resetStores();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const field = (): HTMLTextAreaElement => screen.getByRole<HTMLTextAreaElement>('textbox');
const mirror = (container: HTMLElement): HTMLElement => {
  const element = container.querySelector<HTMLElement>('.quill__mirror');
  if (!element) throw new Error('no mirror layer');
  return element;
};
const mirrorText = (container: HTMLElement): string => mirror(container).textContent.replace(/\u200b/gu, '');

describe('QuillInput: a real textarea rendered as ink', () => {
  it('is a textarea with an accessible name, automatic direction, a placeholder and the question limit', () => {
    render(<QuillInput onSubmit={() => true} />);
    const textarea = screen.getByRole('textbox', { name: 'Write to the diary' });
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea).toHaveAttribute('dir', 'auto');
    expect(textarea).toHaveAttribute('maxlength', String(QUESTION_MAX_CHARS));
    expect(textarea).toHaveAttribute(
      'placeholder',
      'Write your question, and I will answer from your pages alone.',
    );
  });

  it('draws what is typed again as ink on a mirror layer, one span per glyph', async () => {
    const user = userEvent.setup();
    const { container } = render(<QuillInput onSubmit={() => true} />);
    await user.type(field(), 'Who?');
    expect(mirrorText(container)).toBe('Who?');
    const spans = mirror(container).querySelectorAll('span.quill__u');
    expect([...spans].map((span) => span.textContent)).toEqual(['W', 'h', 'o', '?']);
    // the mirror is for the eyes only: the textarea is the control
    expect(mirror(container)).toHaveAttribute('aria-hidden', 'true');
  });

  it('keeps every Arabic word whole: no span ever holds part of an Arabic word', async () => {
    const user = userEvent.setup();
    const { container } = render(<QuillInput onSubmit={() => true} />);
    const text = 'من أسّس المدرسة الكبيرة؟';
    await user.type(field(), text);
    expect(mirrorText(container)).toBe(text);
    const words = new Set(['من', 'أسّس', 'المدرسة', 'الكبيرة']);
    for (const span of mirror(container).querySelectorAll('span.quill__u')) {
      const content = span.textContent;
      if (/\p{Script=Arabic}/u.test(content)) {
        // a span with an Arabic letter in it is a whole word
        expect(words.has(content), JSON.stringify(content)).toBe(true);
      }
    }
    expect(field()).toHaveAttribute('lang', 'ar');
  });

  it('isolates a Latin run inside Arabic text in a <bdi>', async () => {
    const user = userEvent.setup();
    const { container } = render(<QuillInput onSubmit={() => true} />);
    await user.type(field(), 'اقرأ Tips Hindawi ثم');
    const isolated = mirror(container).querySelectorAll('bdi');
    expect(isolated).toHaveLength(1);
    expect(isolated[0]?.textContent).toBe('Tips Hindawi');
    expect(mirror(container)).toHaveAttribute('dir', 'rtl');
  });

  it('mirror spans are plain inline elements: no inline-block, no transform of their own', async () => {
    const user = userEvent.setup();
    const { container } = render(<QuillInput onSubmit={() => true} />);
    await user.type(field(), 'ink مداد');
    for (const span of mirror(container).querySelectorAll<HTMLElement>('span.quill__u')) {
      expect(span.style.transform).toBe('');
      expect(span.style.display).toBe('');
      expect(span.getAttribute('style') ?? '').not.toMatch(/inline-block|transform/u);
    }
  });

  it('a glyph that has landed is not redrawn when the reader types after it (its node is kept)', async () => {
    const user = userEvent.setup();
    const { container } = render(<QuillInput onSubmit={() => true} />);
    await user.type(field(), 'ab');
    const first = mirror(container).querySelector('span.quill__u');
    await user.type(field(), 'c');
    expect(mirror(container).querySelector('span.quill__u')).toBe(first);
    expect(mirrorText(container)).toBe('abc');
  });

  describe('Enter writes, Shift+Enter starts a new line', () => {
    it('Enter submits the trimmed words and empties the field', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn(() => true);
      render(<QuillInput onSubmit={onSubmit} />);
      await user.type(field(), '  Who founded it?  {Enter}');
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith('Who founded it?');
      expect(field().value).toBe('');
    });

    it('Shift+Enter inserts a newline and does not submit', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn(() => true);
      render(<QuillInput onSubmit={onSubmit} />);
      await user.type(field(), 'one{Shift>}{Enter}{/Shift}two');
      expect(onSubmit).not.toHaveBeenCalled();
      expect(field().value).toBe('one\ntwo');
    });

    it('does nothing for an empty or blank field', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn(() => true);
      render(<QuillInput onSubmit={onSubmit} />);
      await user.type(field(), '   {Enter}');
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('keeps the words when the diary cannot take them now (onSubmit says no)', async () => {
      const user = userEvent.setup();
      render(<QuillInput onSubmit={() => false} busy />);
      await user.type(field(), 'Q{Enter}');
      expect(field().value).toBe('Q');
    });

    it('the visible Write button submits too, and the cursor goes back to the field', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn(() => true);
      render(<QuillInput onSubmit={onSubmit} />);
      await user.type(field(), 'Who?');
      await user.click(screen.getByRole('button', { name: 'Write' }));
      expect(onSubmit).toHaveBeenCalledWith('Who?');
      expect(field()).toHaveFocus();
    });
  });

  describe('input methods (IME) are never interrupted', () => {
    it('Enter while a composition is open confirms the composition and does not submit', () => {
      const onSubmit = vi.fn(() => true);
      render(<QuillInput onSubmit={onSubmit} />);
      fireEvent.compositionStart(field());
      fireEvent.change(field(), { target: { value: 'こんにちは' } });
      fireEvent.keyDown(field(), { key: 'Enter', isComposing: true });
      expect(onSubmit).not.toHaveBeenCalled();
      fireEvent.compositionEnd(field());
      fireEvent.keyDown(field(), { key: 'Enter' });
      expect(onSubmit).toHaveBeenCalledWith('こんにちは');
    });

    it('the keyCode 229 Enter of a composition (Safari) does not submit either', () => {
      const onSubmit = vi.fn(() => true);
      render(<QuillInput onSubmit={onSubmit} />);
      fireEvent.change(field(), { target: { value: 'مرحبا' } });
      fireEvent.keyDown(field(), { key: 'Enter', keyCode: 229 });
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('composition events are observed, never stopped or cancelled', () => {
      render(<QuillInput onSubmit={() => true} />);
      for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) {
        const event = new CompositionEvent(type, { bubbles: true, cancelable: true });
        field().dispatchEvent(event);
        expect(event.defaultPrevented, type).toBe(false);
      }
    });
  });

  describe('the gentle counter', () => {
    it('is not there for a short question', async () => {
      const user = userEvent.setup();
      render(<QuillInput onSubmit={() => true} />);
      await user.type(field(), 'short');
      expect(screen.queryByTestId('quill-counter')).not.toBeInTheDocument();
    });

    it('shows how much of the limit is used near it', () => {
      render(<QuillInput onSubmit={() => true} />);
      fireEvent.change(field(), { target: { value: 'x'.repeat(1800) } });
      expect(screen.getByTestId('quill-counter')).toHaveTextContent('1800 of 2000');
    });
  });

  describe('ink specks and the nib', () => {
    const typeFast = async () => {
      const user = userEvent.setup();
      const view = render(<QuillInput onSubmit={() => true} />);
      await user.type(field(), 'quickly written words');
      return view;
    };

    it('fast typing flicks a few specks of ink', async () => {
      const { container } = await typeFast();
      expect(container.querySelectorAll('.quill__speck').length).toBeGreaterThan(0);
      expect(container.querySelectorAll('.quill__speck').length).toBeLessThanOrEqual(6);
    });

    it('reduced motion has no specks', async () => {
      settingsStore.setState({ reducedMotion: 'reduce', reducedMotionResolved: true });
      const { container } = await typeFast();
      expect(container.querySelectorAll('.quill__speck')).toHaveLength(0);
    });

    it('has a nib that follows the caret (a decorative element, not the control)', () => {
      const { container } = render(<QuillInput onSubmit={() => true} />);
      const nib = container.querySelector('.quill__nib');
      expect(nib).toBeInTheDocument();
      expect(nib).toHaveAttribute('aria-hidden', 'true');
    });
  });
});
