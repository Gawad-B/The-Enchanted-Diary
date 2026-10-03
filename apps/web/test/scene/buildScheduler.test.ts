import { describe, expect, it } from 'vitest';
import { runBuild } from '../../src/lib/buildScheduler';

/** A scheduler the test drives by hand. */
function manualScheduler() {
  const queue: (() => void)[] = [];
  return {
    schedule: (task: () => void) => {
      queue.push(task);
    },
    pending: () => queue.length,
    pump: () => {
      const task = queue.shift();
      task?.();
    },
    drain: () => {
      while (queue.length > 0) queue.shift()?.();
    },
  };
}

function* steps(log: string[]): Generator<void, string> {
  log.push('first');
  yield;
  log.push('second');
  yield;
  log.push('third');
  return 'built';
}

describe('runBuild: a long construction spread over several turns of the event loop', () => {
  it('does one step per turn, so the page can answer input in between, then reports the result', () => {
    const scheduler = manualScheduler();
    const log: string[] = [];
    const results: string[] = [];
    runBuild(steps(log), (value) => results.push(value), scheduler.schedule);
    expect(log).toEqual([]);
    scheduler.pump();
    expect(log).toEqual(['first']);
    scheduler.pump();
    expect(log).toEqual(['first', 'second']);
    expect(results).toEqual([]);
    scheduler.pump();
    expect(log).toEqual(['first', 'second', 'third']);
    expect(results).toEqual(['built']);
    expect(scheduler.pending()).toBe(0);
  });

  it('cancelling stops it between steps, never reports, and lets the generator clean up', () => {
    const scheduler = manualScheduler();
    const log: string[] = [];
    let cleaned = false;
    function* withCleanup(): Generator<void, string> {
      try {
        log.push('a');
        yield;
        log.push('b');
        yield;
        return 'never';
      } finally {
        cleaned = true;
      }
    }
    const results: string[] = [];
    const cancel = runBuild(withCleanup(), (value) => results.push(value), scheduler.schedule);
    scheduler.pump();
    cancel();
    scheduler.drain();
    expect(log).toEqual(['a']);
    expect(results).toEqual([]);
    expect(cleaned).toBe(true);
  });

  it('cancelling after it finished does nothing', () => {
    const scheduler = manualScheduler();
    const results: string[] = [];
    const cancel = runBuild(steps([]), (value) => results.push(value), scheduler.schedule);
    scheduler.drain();
    cancel();
    expect(results).toEqual(['built']);
  });

  it('a step that throws is reported to onError, once; the build stops there and nothing is reported as done', () => {
    const scheduler = manualScheduler();
    const log: string[] = [];
    function* failing(): Generator<void, string> {
      log.push('a');
      yield;
      throw new Error('the canvas is gone');
    }
    const results: string[] = [];
    const errors: unknown[] = [];
    const cancel = runBuild(
      failing(),
      (value) => results.push(value),
      scheduler.schedule,
      (error) => errors.push(error),
    );
    scheduler.pump();
    scheduler.pump();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('the canvas is gone');
    expect(results).toEqual([]);
    expect(scheduler.pending()).toBe(0); // no further step was scheduled
    cancel(); // nothing left to cancel, and no second trip into the generator
    expect(log).toEqual(['a']);
  });

  it('without an onError the error is thrown out of the task, as from any other task (callers that cannot handle it opt out)', () => {
    const scheduler = manualScheduler();
    function* failing(): Generator<void, string> {
      yield;
      throw new Error('boom');
    }
    runBuild(failing(), () => undefined, scheduler.schedule);
    scheduler.pump();
    expect(() => {
      scheduler.pump();
    }).toThrow('boom');
  });

  it('an error thrown by onDone is not mistaken for a failed build', () => {
    const scheduler = manualScheduler();
    const errors: unknown[] = [];
    runBuild(
      steps([]),
      () => {
        throw new Error("the caller's own");
      },
      scheduler.schedule,
      (error) => errors.push(error),
    );
    scheduler.pump();
    scheduler.pump();
    expect(() => {
      scheduler.pump();
    }).toThrow("the caller's own");
    expect(errors).toEqual([]);
  });
});
