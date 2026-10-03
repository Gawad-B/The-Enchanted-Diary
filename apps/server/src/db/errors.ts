/*
 * What a failed database call means to the code that made it. node-postgres puts the SQLSTATE in `error.code`; a connection
 * that dies has none (its message says so), and an error of the network has an errno code (`ECONNRESET`).
 */

/** SQLSTATE of a deadlock between two transactions: the database ended this one, and the work is safe to try again. */
const DEADLOCK_DETECTED = '40P01';
/** SQLSTATE of a serialization failure. */
const SERIALIZATION_FAILURE = '40001';

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/** Messages node-postgres gives errors that carry no code: a connection that ended, a pool that could not give one in time. */
const CONNECTION_MESSAGES = [
  'connection terminated',
  'connection ended unexpectedly',
  'timeout exceeded when trying to connect',
  'client has encountered a connection error',
  'cannot use a pool after calling end',
  'server closed the connection unexpectedly',
  'connect econnrefused',
];

const codeOf = (error: unknown): string | null =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;

/** The database ended the transaction because two of them wanted each other's locks. */
export function isDeadlock(error: unknown): boolean {
  const code = codeOf(error);
  return code === DEADLOCK_DETECTED || code === SERIALIZATION_FAILURE;
}

/**
 * The database could not be reached or dropped the connection (a Neon compute waking up or restarting, a pooler resetting a
 * connection, a deadlock): nothing is wrong with the work, and the same call is likely to work a moment later.
 */
export function isTransientDatabaseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = codeOf(error);
  if (code !== null) {
    if (NETWORK_CODES.has(code)) return true;
    if (isDeadlock(error)) return true;
    // 08: connection exceptions, 57P: operator intervention (admin shutdown, crash recovery, cannot connect now),
    // 53: insufficient resources (too many connections), 55P03: lock not available.
    return /^(08|57P|53)/u.test(code) || code === '55P03';
  }
  const message = error.message.toLowerCase();
  return CONNECTION_MESSAGES.some((fragment) => message.includes(fragment));
}

/** Runs `work`, and once more when the database ended it as the victim of a deadlock. */
export async function retryOnDeadlock<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!isDeadlock(error)) throw error;
    return work();
  }
}
