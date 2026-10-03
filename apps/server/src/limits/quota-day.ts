/*
 * Gemini's daily quotas are counted per day in the Pacific time zone and start again at midnight there. The budgets the
 * app keeps in the database use the same days, and a job parked for a used-up quota is resumed at the same moment.
 */

const QUOTA_TIME_ZONE = 'America/Los_Angeles';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const clock = new Intl.DateTimeFormat('en-US', {
  timeZone: QUOTA_TIME_ZONE,
  hourCycle: 'h23',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

/** Milliseconds since midnight on the Pacific clock at `instant`. */
function msIntoPacificDay(instant: Date): number {
  const parts = clock.formatToParts(instant);
  const part = (type: string): number =>
    Number(parts.find((candidate) => candidate.type === type)?.value ?? 0);
  return ((part('hour') * 60 + part('minute')) * 60 + part('second')) * 1000 + instant.getMilliseconds();
}

/** The moment the Pacific day that contains `instant` began. */
export function pacificDayStart(instant: Date): Date {
  // The clock time says how far into the day it is; a day that has a daylight-saving change (23 or 25 hours long) is
  // corrected by looking at the result once more.
  let start = new Date(instant.getTime() - msIntoPacificDay(instant));
  const drift = msIntoPacificDay(start);
  if (drift !== 0) start = new Date(start.getTime() - (drift <= 12 * HOUR_MS ? drift : drift - DAY_MS));
  return start;
}

/** The next midnight on the Pacific clock after `instant`: when the daily quotas start again. */
export function nextQuotaReset(instant: Date): Date {
  // 36 hours after the start of the day is inside the next day whatever the length of this one.
  return pacificDayStart(new Date(pacificDayStart(instant).getTime() + 36 * HOUR_MS));
}
