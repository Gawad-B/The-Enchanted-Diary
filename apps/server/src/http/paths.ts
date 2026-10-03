/**
 * True when a ROUTE PATTERN (`request.routeOptions.url`, such as `/api/documents/:id`) belongs to the API.
 *
 * Always decide on the matched route, never on the raw `request.url`: the router percent-decodes the path
 * before matching, so `/%61pi/health` is served by the route `/api/health` while its raw URL does not start
 * with "/api". A check on the raw URL can be bypassed with an encoded path; the route pattern cannot.
 * `undefined` (no route matched: a 404) is not the API.
 */
export function isApiRoute(pattern: string | undefined): boolean {
  return pattern !== undefined && (pattern === '/api' || pattern.startsWith('/api/'));
}
