import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { countersRepo } from '../db/repositories/counters.js';
import { AppError } from './errors.js';
import { isApiRoute } from './paths.js';

/*
 * Rate limits for a deployment without a long-lived process: the counters are rows of `rate_counters` (one atomic
 * statement per request), shared by every instance. A request over its limit changes nothing, so a client that keeps
 * trying does not push its own window further out.
 */

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Set on a route to leave it out of the global per-IP limit (the health check a platform polls). */
    unlimited?: boolean;
  }
}

/** The error every rate limit answers with (429 RATE_LIMITED). `retryAfter` is a human string such as "42 seconds". */
export function rateLimitedError(retryAfter: string): AppError {
  return new AppError(
    'RATE_LIMITED',
    'Too many requests. Wait a moment and try again.',
    `retry after ${retryAfter}`,
  );
}

export interface RateLimitSpec {
  /**
   * Names the limit. Two limits with different names keep separate counters for the same session or address (for example
   * "uploads" and "questions").
   */
  name: string;
  max: number;
  /** Milliseconds, or a string such as '1 minute' or '1 hour'. */
  timeWindow: number | string;
}

const UNIT_MS: Record<string, number> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

/** A window as milliseconds: a number is taken as it is, a string is "<n> <second|minute|hour|day>[s]" ("1 hour"). */
export function windowMsOf(timeWindow: number | string): number {
  if (typeof timeWindow === 'number') return timeWindow;
  const match = /^\s*(\d+(?:\.\d+)?)?\s*(second|minute|hour|day)s?\s*$/u.exec(timeWindow);
  const unit = match?.[2];
  if (unit === undefined) throw new Error(`not a time window: "${timeWindow}"`);
  return Math.round(Number(match?.[1] ?? 1) * (UNIT_MS[unit] ?? 0));
}

/**
 * Counts one request against `key`; throws the 429 (with Retry-After) when the window is used up.
 * Exported for the handlers that count things that are not requests.
 */
export async function enforceLimit(
  app: FastifyInstance,
  reply: FastifyReply,
  key: string,
  spec: Pick<RateLimitSpec, 'max' | 'timeWindow'>,
): Promise<void> {
  const result = await countersRepo.consume(app.db, {
    key,
    limit: spec.max,
    windowMs: windowMsOf(spec.timeWindow),
  });
  if (result.allowed) return;
  const seconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
  void reply.header('retry-after', seconds);
  throw rateLimitedError(`${String(seconds)} seconds`);
}

/**
 * The global limit: RATE_LIMIT_PER_MINUTE requests per client address, over the API. The built web app (shell, chunks,
 * fonts, wasm) is served by the same server in some deployments and a cold load fetches dozens of files: those are never
 * limited. Decided on the matched route, not the raw URL (see isApiRoute): an encoded path cannot dodge the limit.
 * The address is `request.ip`, which is the one in X-Forwarded-For when TRUST_PROXY is on.
 */
export function registerIpRateLimit(app: FastifyInstance, config: Config): void {
  const spec = { max: config.rateLimitPerMinute, timeWindow: '1 minute' };
  app.addHook('onRequest', async (request, reply) => {
    if (!isApiRoute(request.routeOptions.url)) return;
    if (request.routeOptions.config.unlimited === true) return;
    await enforceLimit(app, reply, `ip:${request.ip}`, spec);
  });
}

/** Gives back one request counted by `perIpRateLimit` (a request that was refused for a reason that is not the visitor's). */
export async function refundIpLimit(
  app: FastifyInstance,
  request: FastifyRequest,
  spec: RateLimitSpec,
): Promise<void> {
  await countersRepo.refund(app.db, `${spec.name}:ip:${request.ip}`, windowStartOf(spec.timeWindow), 1);
}

/** Gives back one request counted by `perSessionRateLimit`. */
export async function refundSessionLimit(
  app: FastifyInstance,
  request: FastifyRequest,
  spec: RateLimitSpec,
): Promise<void> {
  await countersRepo.refund(app.db, `${spec.name}:${request.sessionId}`, windowStartOf(spec.timeWindow), 1);
}

/** The fixed window `consume` puts a request made now in. */
function windowStartOf(timeWindow: number | string): Date {
  const windowMs = windowMsOf(timeWindow);
  return new Date(Math.floor(Date.now() / windowMs) * windowMs);
}

type LimitHook = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * A limit per client ADDRESS on top of the global one, for a route that needs a stricter one (uploads). Use it as the
 * route's `onRequest` hook, which runs before the session is created, so a refused request leaves no session row behind.
 */
export function perIpRateLimit(app: FastifyInstance, spec: RateLimitSpec): LimitHook {
  return async (request, reply) => {
    await enforceLimit(app, reply, `${spec.name}:ip:${request.ip}`, spec);
  };
}

/** One hook per (app, name): routes that call `perSessionRateLimit` with the same name draw on ONE budget per session. */
const limitsByApp = new WeakMap<FastifyInstance, Map<string, { spec: RateLimitSpec; hook: LimitHook }>>();

/**
 * A rate limit per SESSION, in addition to the global per-IP limit. Use it as a route hook:
 *
 *     app.post('/api/documents', { preHandler: [perSessionRateLimit(app, { name: 'uploads', max: 20, timeWindow: '1 hour' })] }, ...)
 *
 * `request.sessionId` is set by the session hook, which runs in `preHandler`, so anything that depends on the session (this
 * limit, queries scoped to the session) runs in `preHandler` or later; `onRequest` is before it, and there the session id is
 * still the empty string. Called without a session it fails loudly with a 500 rather than silently sharing one bucket.
 *
 * Calling this with the same name but a different `max` or `timeWindow` is a programming error and throws.
 */
export function perSessionRateLimit(app: FastifyInstance, spec: RateLimitSpec): LimitHook {
  const memo = limitsByApp.get(app) ?? new Map<string, { spec: RateLimitSpec; hook: LimitHook }>();
  limitsByApp.set(app, memo);
  const existing = memo.get(spec.name);
  if (existing !== undefined) {
    if (existing.spec.max !== spec.max || existing.spec.timeWindow !== spec.timeWindow) {
      throw new Error(
        `perSessionRateLimit("${spec.name}") was already created with different max or timeWindow`,
      );
    }
    return existing.hook;
  }
  const hook: LimitHook = async (request, reply) => {
    if (request.sessionId === '') {
      throw new Error(
        `perSessionRateLimit("${spec.name}") ran without a session: use it in preHandler on a non-public route`,
      );
    }
    await enforceLimit(app, reply, `${spec.name}:${request.sessionId}`, spec);
  };
  memo.set(spec.name, { spec, hook });
  return hook;
}
