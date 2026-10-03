import { z } from 'zod';

/*
 * Every schema in the product is built with this `z`, and this module configures zod before any of them
 * exists: `api.ts` imports `z` from here, `index.ts` re-exports it, and web code is not allowed to import
 * zod directly (ESLint). So every entry point that touches a schema (the main bundle, a future Worker, the
 * server) is covered, whatever order the bundler evaluates modules in.
 *
 * Why: zod 4 decides at schema construction time whether to compile validators with `new Function`, probing
 * for it with `new Function('')`. The throw is caught, but a production Content-Security-Policy without
 * 'unsafe-eval' still reports it as a `securitypolicyviolation`. `jitless` skips the probe and the compiler.
 * The cost is slower parsing of the few small JSON bodies this app handles; the server pays it too, which is
 * negligible next to PDF work and retrieval.
 */
z.config({ jitless: true });

export { z };
