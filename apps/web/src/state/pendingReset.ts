/**
 * The session reset that "Start a new session" asked for and that may still be on its way. The next upload waits for it
 * before it asks for a ticket: a ticket asked for under the old cookie and a token fetched under the new one would be refused
 * as belonging to different sessions. Not reactive: nothing renders from it.
 */
let pending: Promise<void> = Promise.resolve();

export const pendingReset = {
  /** Remembers a reset in flight (its failure is the caller's to report; here it only counts as "over"). */
  track(reset: Promise<unknown>): void {
    pending = reset.then(
      () => undefined,
      () => undefined,
    );
  },
  /** Resolves when the last tracked reset is over (at once when there is none). */
  settled(): Promise<void> {
    return pending;
  },
};
