import { describe, expect, it } from 'vitest';
import { DURATIONS, duration } from '../../src/motion/durations';
import {
  REVEAL_HARD_CAP_MS,
  REVEAL_LAG_MS,
  REVEAL_MAX_TAIL_MS,
  REVEAL_SPEEDUP,
  choreography,
  leadLength,
  newReveal,
  replyStartAt,
  revealStep,
  sinkPlan,
  type RevealParams,
} from '../../src/motion/ink';

describe('the ink duration tokens (experience research section 4)', () => {
  it('has the rows of the timing table, and a short reduced-motion variant for each', () => {
    expect(duration('inkGlyphIn', false)).toBe(60);
    expect(duration('inkWetSheen', false)).toBe(700);
    expect(duration('commitHold', false)).toBe(150);
    expect(duration('sinkWord', false)).toBe(520);
    expect(duration('sinkStagger', false)).toBe(45);
    expect(duration('replyGlyph', false)).toBe(240);
    expect(duration('replyStagger', false)).toBe(30);
    expect(duration('replyDry', false)).toBe(1800);
    expect(duration('replyWord', false)).toBe(320);
    expect(duration('replyWordStagger', false)).toBe(90);
    expect(duration('replyBreath', false)).toBe(250);
    expect(duration('citationDelay', false)).toBe(400);
    expect(duration('citationFade', false)).toBe(200);
    for (const name of [
      'inkGlyphIn',
      'inkWetSheen',
      'commitHold',
      'sinkWord',
      'sinkStagger',
      'replyGlyph',
      'replyDry',
      'replyWord',
      'citationFade',
    ] as const) {
      expect(duration(name, true), name).toBeLessThanOrEqual(250);
      expect(duration(name, true), name).toBeLessThanOrEqual(DURATIONS[name].normal);
    }
  });
});

describe('sinkPlan: the question sinks word by word', () => {
  it('a short question: 520 ms per word, 45 ms apart, the last one lands 520 ms after the last start', () => {
    const plan = sinkPlan(3, false);
    expect(plan).toMatchObject({ perWordMs: 520, staggerMs: 45, crossfade: false });
    expect(plan.totalMs).toBe(520 + 2 * 45);
  });

  it('one word has no stagger', () => {
    expect(sinkPlan(1, false)).toMatchObject({ staggerMs: 45, totalMs: 520 });
  });

  it('a longer question is squeezed toward a total of 1000 ms, and never past the 1600 ms cap', () => {
    expect(sinkPlan(11, false).totalMs).toBeLessThanOrEqual(970);
    expect(sinkPlan(20, false).totalMs).toBeLessThanOrEqual(1000);
    for (const words of [2, 5, 11, 12, 20, 40, 100, 400, 2000]) {
      const plan = sinkPlan(words, false);
      expect(plan.totalMs, `${words} words`).toBeLessThanOrEqual(1600);
      expect(plan.staggerMs, `${words} words`).toBeGreaterThan(0);
    }
  });

  it('reduced motion is one short crossfade of the whole block, with no stagger', () => {
    for (const words of [1, 7, 300]) {
      expect(sinkPlan(words, true)).toEqual({
        perWordMs: 250,
        staggerMs: 0,
        totalMs: 250,
        crossfade: true,
      });
    }
  });
});

describe('choreography and the start of the reply', () => {
  it('holds the words for 150 ms, then sinks them; the reply may start 250 ms after the sink', () => {
    const plan = choreography(3, false);
    expect(plan.sinkStartMs).toBe(150);
    expect(plan.sinkEndMs).toBe(150 + 610);
    expect(plan.replyEarliestMs).toBe(150 + 610 + 250);
  });

  it('reduced motion: no hold, no breath', () => {
    const plan = choreography(3, true);
    expect(plan.sinkStartMs).toBe(0);
    expect(plan.sinkEndMs).toBe(250);
    expect(plan.replyEarliestMs).toBe(250);
  });

  it('reply_start = max(sink_end + 250, first token): a slow model sets the pace, a fast one waits for the sink', () => {
    const plan = choreography(3, false);
    const submitted = 10_000;
    expect(replyStartAt(submitted, null, plan)).toBeNull();
    expect(replyStartAt(submitted, submitted + 300, plan)).toBe(submitted + plan.replyEarliestMs);
    expect(replyStartAt(submitted, submitted + 5000, plan)).toBe(submitted + 5000);
  });
});

describe('leadLength: the first sentence is written in the diary hand, the rest as fair copy', () => {
  it('ends at the first sentence end', () => {
    expect(leadLength('It was founded in 1847. The rest follows here.')).toBe(
      'It was founded in 1847.'.length,
    );
    expect(leadLength('Who? Me.')).toBe(4);
    expect(leadLength('سأخبرك. ثم أكمل')).toBe('سأخبرك.'.length);
    expect(leadLength('هل؟ نعم')).toBe(3);
  });

  it('is capped at about 160 characters, cut at a word boundary', () => {
    const long = 'word '.repeat(60);
    const length = leadLength(long);
    expect(length).toBeLessThanOrEqual(160);
    expect(length).toBeGreaterThan(140);
    expect(long.slice(0, length).endsWith('word')).toBe(true);
  });

  it('while no sentence has ended yet, the whole text so far is the lead (it cannot move backwards as text streams in)', () => {
    expect(leadLength('It was founded')).toBe('It was founded'.length);
    const streamed = ['It was', 'It was found', 'It was founded in 1847.', 'It was founded in 1847. And'];
    const lengths = streamed.map(leadLength);
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
    expect(leadLength('A. B.')).toBe(2);
  });
});

describe('the reveal clock: the pen catches up with the stream', () => {
  const glyphs: RevealParams = { stepMs: 30, startedAt: 0 };

  /** Runs the clock in 16 ms frames; `available` and `endedAt` can depend on the time. */
  function run(
    until: number,
    available: (now: number) => number,
    endedAt: number | null,
    params: RevealParams = glyphs,
  ) {
    let state = newReveal();
    const trace: { now: number; revealed: number }[] = [];
    for (let now = 0; now <= until; now += 16) {
      state = revealStep(
        state,
        now,
        available(now),
        endedAt !== null && now >= endedAt ? endedAt : null,
        params,
      );
      trace.push({ now, revealed: state.revealed });
    }
    return trace;
  }

  it('writes about one glyph per 30 ms when the text is all there', () => {
    const trace = run(1000, () => 400, null);
    const at = (ms: number): number => trace.find((entry) => entry.now >= ms)?.revealed ?? 0;
    expect(at(480)).toBeGreaterThanOrEqual(12);
    expect(at(480)).toBeLessThanOrEqual(24);
  });

  it('never reveals more than has arrived, and waits for the stream', () => {
    const trace = run(2000, (now) => Math.floor(now / 200), null);
    for (const entry of trace) expect(entry.revealed).toBeLessThanOrEqual(Math.floor(entry.now / 200));
  });

  it('speeds up 1.5x while the pen lags the stream by more than 1200 ms', () => {
    const lagging = REVEAL_LAG_MS / glyphs.stepMs + 20; // units behind: a lag over 1200 ms
    let state = newReveal();
    state = revealStep(state, 0, lagging * 2, null, glyphs);
    const before = state.revealed;
    state = revealStep(state, 300, lagging * 2, null, glyphs);
    const fast = state.revealed - before;
    let slow = newReveal();
    slow = revealStep(slow, 0, 10, null, glyphs);
    const slowBefore = slow.revealed;
    slow = revealStep(slow, 300, 10, null, glyphs);
    // A frame gap is capped (a hidden tab must not jump): 250 ms is about 8 glyphs at the base pace, about 12 lagging
    expect(fast).toBeGreaterThanOrEqual(Math.floor((slow.revealed - slowBefore) * (REVEAL_SPEEDUP - 0.2)));
    expect(fast).toBeGreaterThan(10);
  });

  it('finishes no later than the end of the stream plus 1.2 s, however much is left to write', () => {
    // 600 glyphs arrive at once and the stream ends at 500 ms: the pen has 1200 ms after that.
    const trace = run(5000, () => 600, 500);
    const finished = trace.find((entry) => entry.revealed >= 600);
    expect(finished).toBeDefined();
    expect(finished?.now ?? Infinity).toBeLessThanOrEqual(500 + REVEAL_MAX_TAIL_MS + 16);
  });

  it('a stream that ended long ago is revealed at once', () => {
    let state = newReveal();
    state = revealStep(state, 20_000, 800, 1_000, glyphs);
    expect(state.revealed).toBe(800);
  });

  it('after 8 s of writing, whatever is left is shown at once (and fades in)', () => {
    let state = newReveal();
    state = revealStep(state, 0, 5000, null, glyphs);
    state = revealStep(state, REVEAL_HARD_CAP_MS + 1, 5000, null, glyphs);
    expect(state.revealed).toBe(5000);
  });

  it('is gentle with a long gap between frames (a hidden tab): it does not jump ahead on its own', () => {
    let state = newReveal();
    state = revealStep(state, 0, 40, null, glyphs);
    state = revealStep(state, 600_000 - 7000, 40, null, { ...glyphs, startedAt: 600_000 - 7000 });
    // 40 units at 30 ms: at most the lag rule applies, never beyond what is available
    expect(state.revealed).toBeLessThanOrEqual(40);
  });

  it('Arabic words are written at 90 ms per word', () => {
    const words: RevealParams = { stepMs: 90, startedAt: 0 };
    const trace = run(960, () => 12, null, words); // 12 words behind is 1080 ms: inside the lag limit, so the base pace
    const at = (ms: number): number => trace.find((entry) => entry.now >= ms)?.revealed ?? 0;
    expect(at(896)).toBeGreaterThanOrEqual(7);
    expect(at(896)).toBeLessThanOrEqual(11);
  });
});
