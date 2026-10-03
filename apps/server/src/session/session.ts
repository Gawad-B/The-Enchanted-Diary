import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { isApiRoute } from '../http/paths.js';

/** Name of the signed, httpOnly session cookie. */
export const SESSION_COOKIE = 'ed_sid';

/** `last_seen_at` is refreshed at most this often per session. */
const TOUCH_INTERVAL_SECONDS = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

declare module 'fastify' {
  interface FastifyRequest {
    /** The anonymous session id from the signed cookie. Empty string on routes without a session. */
    sessionId: string;
  }
  interface FastifyContextConfig {
    /** Set on a route to opt out of session handling (health checks, public config). */
    public?: boolean;
  }
}

/** Sets the signed session cookie; its lifetime is the absolute document cap, and it slides with activity. */
export function issueSessionCookie(reply: FastifyReply, config: Config, sessionId: string): void {
  void reply.setCookie(SESSION_COOKIE, sessionId, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    signed: true,
    maxAge: Math.round(config.documentMaxRetentionHours * 3600),
  });
}

/**
 * Anonymous, cookie-based sessions. Every matched `/api/*` route gets `request.sessionId` unless its route
 * config says `public: true`. The cookie is signed (a forged id is simply replaced), and the `sessions` row is
 * created on first sight and re-created if the retention sweep removed it. Documents are always queried by
 * session id, so one session can never see another's data.
 */
export function registerSession(app: FastifyInstance, config: Config, db: Db): void {
  app.decorateRequest('sessionId', '');

  // preHandler, not onRequest: the rate limiter is a route-level onRequest hook and app-level hooks of the same
  // stage run before route-level ones, so an onRequest session hook would insert a row for every request,
  // including the ones the limiter then rejects. By the time preHandler runs, the request has been admitted
  // (and its body parsed and validated).
  app.addHook('preHandler', async (request, reply) => {
    // Decided on the matched route (undefined for unknown routes: scanners must not create session rows),
    // never on the raw URL: `/%61pi/...` reaches the same route as `/api/...`.
    if (!isApiRoute(request.routeOptions.url)) return;
    if (request.routeOptions.config.public === true) return;

    const raw = request.cookies[SESSION_COOKIE];
    const unsigned = raw === undefined ? null : request.unsignCookie(raw);
    const existing = unsigned?.valid === true && UUID.test(unsigned.value) ? unsigned.value : null;
    const sessionId = existing ?? randomUUID();
    request.sessionId = sessionId;

    // One statement creates the row, or refreshes last_seen_at at most once per TOUCH_INTERVAL_SECONDS.
    // It returns a row only when it wrote something, which is also when the cookie is (re)issued so that
    // its lifetime slides with activity.
    const written = await db.query(
      `INSERT INTO sessions (id) VALUES ($1)
       ON CONFLICT (id) DO UPDATE SET last_seen_at = now()
         WHERE sessions.last_seen_at < now() - make_interval(secs => $2)
       RETURNING id`,
      [sessionId, TOUCH_INTERVAL_SECONDS],
    );
    if (existing === null || written.rowCount > 0) issueSessionCookie(reply, config, sessionId);
  });
}
