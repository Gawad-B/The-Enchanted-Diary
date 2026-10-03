/**
 * Runs a long construction (the scene's procedural textures, a marbled endpaper) one step per turn of the event loop.
 * A generator yields between heavy steps, so the page keeps answering input while it builds, and a mount that goes away
 * (a quality change, a hidden StrictMode pass) cancels it between steps without leaking what it made. A step that throws
 * is reported to `onError` (a throw out of a timer would be nobody's to catch: no result, no log, no clean-up).
 */
export type Scheduler = (task: () => void) => void;

const defaultScheduler: Scheduler = (task) => {
  setTimeout(task, 0);
};

/**
 * Starts `build`; calls `onDone` with its result unless cancelled first, or `onError` with what a step threw (the build
 * stops there; without an `onError` the error is thrown out of the timer, as it would be from any other task). Returns
 * the cancel function.
 */
export function runBuild<T>(
  build: Generator<void, T>,
  onDone: (value: T) => void,
  schedule: Scheduler = defaultScheduler,
  onError?: (error: unknown) => void,
): () => void {
  let cancelled = false;
  let finished = false;
  const step = (): void => {
    if (cancelled) return;
    let result: IteratorResult<void, T>;
    try {
      result = build.next();
    } catch (error) {
      finished = true; // a generator that threw is closed: there is nothing to cancel
      if (!onError) throw error;
      onError(error);
      return;
    }
    if (result.done) {
      finished = true;
      onDone(result.value);
    } else {
      schedule(step);
    }
  };
  schedule(step);
  return () => {
    if (cancelled || finished) return;
    cancelled = true;
    build.return(undefined as T);
  };
}
