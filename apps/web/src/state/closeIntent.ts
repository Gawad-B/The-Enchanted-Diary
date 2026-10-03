/**
 * What the next closing of the diary is for. Closing the diary and starting a new session both begin with CLOSE_REQUESTED
 * (the book closes the same way), but the second must also reset the session on the server. The component that asks marks
 * the intent; the close effect reads it once when the diary starts to close. Not reactive: nothing renders from it.
 */
let reset = false;

export const closeIntent = {
  /** The next closing also resets the session (every document of it is removed and the browser gets a new session). */
  requestReset(): void {
    reset = true;
  },
  /** Reads and clears the intent. */
  takeReset(): boolean {
    const asked = reset;
    reset = false;
    return asked;
  },
  clear(): void {
    reset = false;
  },
};
