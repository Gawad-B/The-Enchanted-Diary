import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatStore } from '../../src/state/chatStore';
import { createExperienceStore, initialExperienceState, type Phase } from '../../src/state/experience';
import { createFlyleafStore } from '../../src/ui/diary/flyleafStore';
import { submitText } from '../../src/ui/diary/submit';

const showTruth = vi.fn(() => true);

function setup(phase: Phase) {
  const experience = createExperienceStore({ ...initialExperienceState, phase, sessionChecked: true });
  const chat = createChatStore();
  const flyleaf = createFlyleafStore();
  return {
    experience,
    chat,
    flyleaf,
    submit: (text: string) => submitText(text, { experience, chat, flyleaf, showTruth }),
  };
}

beforeEach(() => {
  showTruth.mockClear();
});

describe('submitText: what happens to the words the reader writes', () => {
  describe('in the manuscript', () => {
    it('an ordinary question starts a turn', () => {
      const { submit, chat } = setup('manuscript');
      expect(submit('Who founded it?')).toBe('sent');
      expect(chat.getState().turn?.question).toBe('Who founded it?');
    });

    it('the diary is told to wait when another answer is still being written', () => {
      const { submit, chat } = setup('manuscript');
      submit('One?');
      expect(submit('Two?')).toBe('busy');
      expect(chat.getState().turn?.question).toBe('One?');
    });

    it.each([
      'But I can show you...',
      'but i can show you',
      'Show me what is hidden.',
      'Reveal the secrets.',
      'Show me what lies within.',
      'لكنني أستطيع أن أُريك…',
      'أرني ما هو مخفي.',
      'Show me what is hiden', // a near miss is still the phrase
    ])(
      'the phrase "%s" is never asked: with nothing answered yet the diary has nothing to show',
      (phrase) => {
        const { submit, chat, experience, flyleaf } = setup('manuscript');
        expect(submit(phrase)).toBe('sent');
        expect(experience.getState().phase).toBe('manuscript');
        expect(showTruth).not.toHaveBeenCalled();
        expect(flyleaf.getState().current).toBeNull();
        expect(chat.getState().turn).toMatchObject({ question: phrase, status: 'done' });
        expect(chat.getState().turn?.localText).toMatch(/\S/u);
        expect(chat.getState().askStatus).toBe('idle');
      },
    );

    it('the phrase shows the truth of the latest answered exchange', () => {
      const { submit, chat, experience } = setup('manuscript');
      const at = '2026-01-01T00:00:00Z';
      chat.getState().setMessages([
        { id: 'q1', role: 'user', kind: 'question', content: 'Who?', citations: [], createdAt: at },
        { id: 'a1', role: 'assistant', kind: 'answer', content: 'Her.', citations: [], createdAt: at },
        { id: 'q2', role: 'user', kind: 'question', content: 'When?', citations: [], createdAt: at },
        { id: 'a2', role: 'assistant', kind: 'answer', content: 'Then.', citations: [], createdAt: at },
      ]);
      expect(submit('Show me what is hidden.')).toBe('sent');
      expect(showTruth).toHaveBeenCalledWith('q2');
      expect(experience.getState().phase).toBe('manuscript');
      expect(chat.getState().turn).toBeNull();
    });

    it('a real question that merely contains a phrase is a question', () => {
      const { submit, chat, experience } = setup('manuscript');
      submit('Can you show me what is hidden in chapter three of the report about the founding?');
      expect(experience.getState().phase).toBe('manuscript');
      expect(chat.getState().turn).not.toBeNull();
    });
  });

  describe('before there is a manuscript (the flyleaf)', () => {
    it('the diary answers in its own voice, cycling through three lines by attempt', () => {
      const { submit, flyleaf, chat } = setup('awaiting');
      submit('Hello?');
      expect(flyleaf.getState().current?.line).toBe('first');
      submit('Anyone there?');
      expect(flyleaf.getState().current?.line).toBe('second');
      submit('Please?');
      expect(flyleaf.getState().current?.line).toBe('third');
      submit('Again?');
      expect(flyleaf.getState().current?.line).toBe('third');
      expect(chat.getState().turn).toBeNull(); // nothing was asked of the server
    });

    it('the secret phrase gets the "nothing to show you yet" line and does not count as an attempt', () => {
      const { submit, flyleaf, experience } = setup('awaiting');
      submit('But I can show you...');
      expect(flyleaf.getState().current?.line).toBe('nothing');
      expect(experience.getState().phase).toBe('awaiting');
      submit('Hello?');
      expect(flyleaf.getState().current?.line).toBe('first');
    });

    it('each write is a new exchange (so its ink sinks again)', () => {
      const { submit, flyleaf } = setup('awaiting');
      submit('One');
      const first = flyleaf.getState().current?.id;
      submit('Two');
      expect(flyleaf.getState().current?.id).not.toBe(first);
      expect(flyleaf.getState().current?.question).toBe('Two');
    });
  });

  it('is ignored in every other phase', () => {
    for (const phase of [
      'discovery',
      'opening',
      'uploading',
      'reading',
      'unveiling',
      'revealing',
      'memory',
      'closing',
    ] as const) {
      const { submit, chat, flyleaf } = setup(phase);
      expect(submit('Hello?'), phase).toBe('ignored');
      expect(chat.getState().turn).toBeNull();
      expect(flyleaf.getState().current).toBeNull();
    }
  });
});
