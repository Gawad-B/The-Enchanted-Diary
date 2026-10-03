import { dominantDirection } from '@enchanted/shared';
import { useMemo } from 'react';
import { duration } from '../../motion/durations';
import { leadLength } from '../../motion/ink';
import { displayText, parseAnswer, plainText } from './format';
import { buildInkDoc, leadUnitCount, type InkDoc } from './inkDoc';

export interface AnswerDoc {
  doc: InkDoc;
  /** Pieces of ink in the diary's hand (the first sentence). */
  leadUnits: number;
  /** The pen's pace for this script: a glyph at a time, or a word at a time in Arabic. */
  stepMs: number;
  /** What a reader (or a screen reader) is shown: markers removed, plain paragraphs. */
  plain: string;
}

/**
 * An answer's raw text made ready for the pen: markers removed and an unfinished one held back while it streams, the whitelist
 * formatter, the pieces of ink, where the lead ends and the pen's pace.
 */
export function useAnswerDoc(raw: string, streaming: boolean): AnswerDoc {
  return useMemo(() => {
    const shown = displayText(raw, streaming);
    const paragraphs = parseAnswer(shown, streaming);
    const doc = buildInkDoc(paragraphs);
    const plain = plainText(paragraphs);
    return {
      doc,
      plain,
      leadUnits: leadUnitCount(doc, leadLength(plain)),
      stepMs: duration(dominantDirection(plain) === 'rtl' ? 'replyWordStagger' : 'replyStagger', false),
    };
  }, [raw, streaming]);
}
