import { dominantDirection } from '@enchanted/shared';
import { useMemo, useState } from 'react';
import type { DiaryExchange } from '../../diarypage/exchanges';
import { duration } from '../../motion/durations';
import { choreography, replyStartAt, type Choreography } from '../../motion/ink';
import { isSettled, type Turn } from '../../state/chatTurn';
import { useSettingsStore } from '../../state/settingsStore';
import { wordsOf } from './segment';
import { useReveal } from './useReveal';
import type { FreshInk } from './PageLines';

export interface CurrentInk {
  fresh: FreshInk;
  plan: Choreography;
  /** The pen has begun to write the reply (the line that says the diary is listening gives way to it). */
  writing: boolean;
  /** The reply is on the page in full and nothing more will come, or the question could not be answered: sources and notes may show. */
  written: boolean;
  /** The reply is Arabic (or another right-to-left script) and still being written: the pen front follows it. */
  penFront: boolean;
}

/**
 * How far the exchange being written has got on the page: the question holds and sinks, the reply may start when the sink is
 * done (and the first token has come), and the pen writes it at its pace, following the stream (research section 4). The
 * component that calls this is mounted afresh for every attempt of every turn; a turn that was already settled when it was
 * first shown (the reader came back to the page after it was written) is simply on the page, not written a second time.
 */
export function useCurrentInk(exchange: DiaryExchange, turn: Turn): CurrentInk {
  const reduced = useSettingsStore((state) => state.reducedMotionResolved);
  const settled = isSettled(turn);
  const [already] = useState(settled);
  const plan = useMemo(() => choreography(wordsOf(turn.question).length, reduced), [turn.question, reduced]);
  const total = exchange.answer?.total ?? 0;
  // A refusal or a list of passages has no stream of tokens: its text is there when the answer is.
  const firstInk = turn.firstTokenAt ?? (turn.done ? turn.streamEndedAt : null);
  const startAt = replyStartAt(turn.submittedAt, firstInk, plan);
  const rtl = dominantDirection(exchange.plain) === 'rtl';
  const revealed = useReveal({
    startAt,
    available: turn.hidden ? 0 : total,
    // "Done 1.2 s after the stream ended": counted from the moment the pen could start, when the stream finished during the sink.
    endedAt: turn.streamEndedAt === null || startAt === null ? null : Math.max(turn.streamEndedAt, startAt),
    settled,
    stepMs: duration(rtl ? 'replyWordStagger' : 'replyStagger', false),
    enabled: !reduced && !already,
  });
  const shown = already || turn.status === 'failed' ? total : revealed;
  const written = turn.status === 'failed' || (settled && shown >= total && !turn.hidden);
  return {
    fresh: {
      exchange: exchange.id,
      revealed: shown,
      animate: !already,
      sink: already ? null : { plan: plan.sink, holdMs: plan.sinkStartMs },
    },
    plan,
    writing: shown > 0,
    written,
    penFront: !already && !reduced && !written && rtl,
  };
}
