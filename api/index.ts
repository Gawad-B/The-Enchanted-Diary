// The one Vercel function: the whole API (see apps/server/src/vercel.ts). It is `api/index.ts` and not `api/[...path].ts` on
// purpose: outside Next.js, Vercel's filesystem routing turns `[...path]` into a route for exactly ONE path segment, so
// `/api/session/document` would never get here. Instead `vercel.json` rewrites `/api/(.*)` to `/api` (this function), which
// sees the original URL; the SPA is static output. `@enchanted/server/vercel` resolves to the compiled server
// (apps/server/dist) when the function runs, and to its sources for the type checker.
export { default } from '@enchanted/server/vercel';
