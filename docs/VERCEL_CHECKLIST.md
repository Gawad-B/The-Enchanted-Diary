# Vercel Hobby deploy checklist (owner)

This is a **demo deployment**: it is not hardened against abuse of a free
tier, so do not publish the URL widely and do not offer confidential documents to it. Hobby is for non-commercial use. The app
is a fan-inspired concept, not an official Warner Bros. or Wizarding World product (the UI says so).

Shape: one Vite SPA (static, `apps/web/dist`) plus one Vercel Function (`api/index.ts`, the whole Fastify app; 300 s, 2 GB,
4.5 MB request body, 250 MB unzipped), a Neon Postgres with pgvector, and a private Vercel Blob store for the PDFs (the browser
uploads straight to it, past the 4.5 MB body limit). `vercel.json` carries the build, the function's extra files, the
rewrites, the security headers and the cron.

## 0. Before deploying (locally)

- [ ] `npm run typecheck && npm run lint && npm test` pass.
- [ ] `npm run build && npm run check:client && npm run check:vercel` pass: the web bundle has no key and no server-only name,
      the CSP in `vercel.json` equals `apps/server/src/http/security.ts`, the function is under 250 MB with the worker, the
      migrations, pdf.js and the native canvas in it.
- [ ] `npm run e2e` passes (deterministic server: scripted model, no Gemini calls).

## 1. Project

- [ ] Import the repository with the **repository root** as Root Directory.
- [ ] Node version comes from `engines.node` (`22.x`) in `package.json`, which overrides the dashboard: change that field,
      not the setting.
- [ ] Turn **Fluid compute** on (Settings, Functions).
- [ ] Build command is already in `vercel.json`: `npm run vercel-build` (builds shared, server, web; runs `check:vercel`; only
      then applies migrations). Output directory `apps/web/dist`. Pick the database's region (`iad1`).
- [ ] Keep "Automatically expose System Environment Variables" **on** (the preview guard reads `VERCEL_ENV`).

## 2. Database (Neon)

- [ ] Storage, Create, Neon (or `vercel install neon`); the free plan is enough. It sets `DATABASE_URL` (pooled: what the
      function uses, pool of `DATABASE_POOL_MAX`=3) and `DATABASE_URL_UNPOOLED` (preferred by the build's migration step).
- [ ] The first migration runs `CREATE EXTENSION vector`. A free Neon project sleeps after 5 idle minutes; the first request
      after that waits about a second.

## 3. Blob store

- [ ] Storage, Create, Blob, access **Private** (cannot be changed later); connect it to the project: that sets
      `BLOB_READ_WRITE_TOKEN`. Set `STORAGE_PROVIDER=vercel-blob` (the server refuses the local disk on Vercel).
- [ ] Hobby: 1 GB stored, 10,000 simple and 2,000 advanced operations, 10 GB transfer a month. Going over blocks Blob for
      30 days for everyone. The app's own budgets (`BLOB_MAX_TOTAL_MB` 800, `BLOB_MAX_WRITES_PER_DAY` 60,
      `FILE_READS_PER_DOC_PER_DAY` 20, `MAX_UPLOAD_MB` 20) help but do not bound transfer for someone who tries; lower them
      and keep `DOCUMENT_RETENTION_HOURS` short if this is shown to others. Watch the Usage page.

## 4. One database and one Blob store per environment

A preview given production's `DATABASE_URL` would migrate production's schema at build time, and one given production's Blob
token could delete production's blobs. So either:

- [ ] scope `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `BLOB_READ_WRITE_TOKEN` to **Production** only (then previews build and
      serve the SPA but every `/api` call answers 500: `DATABASE_URL: is required on Vercel`), **or**
- [ ] enable Neon preview branching, give Preview its own Blob store, and set `ALLOW_PREVIEW_DATA=true` for **Preview only**.

Outside `VERCEL_ENV=production` the build's migration step, the cold-start migration, the retention pass and orphan-blob
removal refuse to run unless `ALLOW_PREVIEW_DATA=true`. The first preview build log must say "migrations skipped" when it
should not migrate. Never call the cron of a preview that shares a store. Write migrations expand-then-contract (add, never
rename or drop in one step): the build migrates before the new deployment goes live.

## 5. Environment variables (Settings, Environment Variables)

Documented in `.env.example` and `apps/server/src/config.ts`; **do not import `.env.example` wholesale** (its defaults are for
a laptop).

| Variable                                                                                      | Value                                                                                        |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `SESSION_SECRET`                                                                              | required: 32+ random characters (`openssl rand -hex 32`)                                     |
| `GEMINI_API_KEY`                                                                              | required: your key, server side only (answers, embeddings, reading scanned pages)            |
| `STORAGE_PROVIDER`                                                                            | `vercel-blob` (required on Vercel)                                                           |
| `CRON_SECRET`                                                                                 | required for the cron: a long random string (Vercel sends `Authorization: Bearer ...`)       |
| `GEMINI_FREE_TIER`                                                                            | `true` for a free key (the UI discloses that Google may use what is sent), `false` if billed |
| `GEMINI_DAILY_BUDGET_LLM` / `_EMBED` / `_OCR` / `_AUX`                                        | about 80% of your real daily quotas (defaults 300 / 800 / 100 / 400)                         |
| `BLOB_MAX_TOTAL_MB`, `BLOB_MAX_WRITES_PER_DAY`, `FILE_READS_PER_DOC_PER_DAY`, `MAX_UPLOAD_MB` | the Blob budgets above (defaults 800 / 60 / 20 / 20)                                         |
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `BLOB_READ_WRITE_TOKEN`                              | set by the integrations (Production only, or per branch: see 4)                              |
| `ALLOW_PREVIEW_DATA`                                                                          | unset in Production; `true` in Preview only with its own database and Blob store             |
| `TRUST_PROXY`                                                                                 | leave unset (on by default on Vercel; `false` makes every visitor one address)               |
| `NODE_ENV`, `VERCEL`, `VERCEL_ENV`                                                            | set by Vercel; do not set                                                                    |

On Vercel the server also refuses to start with `STORAGE_PROVIDER=local`, without `SESSION_SECRET`, or with
`INGEST_TICK_HARD_LIMIT_MS` above 285000.

## 6. Cron and firewall

- [ ] `vercel.json` declares one daily cron, `GET /api/cron/retention` (09:00 UTC): expired documents and their blobs,
      unclaimed upload-ticket blobs, old counters. It does not resume parked documents. Vercel calls only the Production
      deployment's cron; Hobby runs it once a day with up to an hour of imprecision.
- [ ] Add the one Hobby WAF rate-limit rule, per IP on `/api/*` (for example 120 requests a minute).

## 7. Deploy

- [ ] Deploy by **git push** (preview for a pull request, production for the production branch) or a remote build.
- [ ] If you use the CLI (`vercel`, `vercel --prod`): the CLI does not read `.gitignore`; `.vercelignore` keeps `.env` and
      `.data/` out of the upload. Check the deployment's **Source** tab shows none of them.
- [ ] **Never `vercel deploy --prebuilt`**: the CLI applies `.vercelignore`'s `**/dist` to the built functions and drops
      `apps/server/dist` and `packages/shared/dist`, so every `/api` request fails at start.

## 8. Preview spike (once, on a preview with its own database and Blob store, `ALLOW_PREVIEW_DATA=true`, a `CRON_SECRET`)

- [ ] 1 Routing: `GET /api/health` is 200 JSON; multi-segment paths reach the function (`/api/session/document` answers JSON,
      `POST /api/uploads/ticket` answers a ticket); `/some/route` is the SPA shell; `/api/nope` is the API's 404 and
      `/assets/missing.js` a 404, not the shell. If a multi-segment path 404s the `/api/(.*)` rewrite is not in effect.
- [ ] 2 Bundle: deployment output shows the function well under 250 MB, no Tesseract or PGlite. Upload
      `fixtures/text-en.pdf`; "Cannot find module .../worker.js" means the worker is missing from the trace (add to
      `includeFiles` and `check-vercel-bundle.ts`).
- [ ] 3 pdf.js: an English and an Arabic PDF are read to the end ("Setting up fake worker failed" means
      `pdfjs-dist/legacy/build/pdf.worker.mjs` is not beside `pdf.mjs`).
- [ ] 4 Native canvas: `fixtures/scanned-ar-locked.pdf` is read (loads `@napi-rs/canvas`; check the
      `@napi-rs/canvas-linux-x64-gnu` entry of `includeFiles` if not).
- [ ] 5 Blob: upload a PDF **over 4.5 MB** with DevTools open: the browser's client gets a token, sends the file to
      `https://vercel.com/api/blob/`, and `POST /api/documents` finds the blob. **No CSP violation in the console**
      (`connect-src 'self' https://vercel.com/api/blob/`); a violation makes the client retry about 17 minutes. A ticket used
      twice is refused.
- [ ] 6 Database: migrations ran in the build log (a preview not meant to migrate says "migrations skipped"); a request after
      5 idle minutes still answers; `/api/health` reports `db: "pg"`; watch the connection count with three documents read.
- [ ] 7 Ticks: a 300-page document reads to the end (ticks about 45 s, none over 300 s), function memory under 2 GB; a scanned
      document with OCR reads about 16 pages per tick.
- [ ] 8 Parking: set `GEMINI_DAILY_BUDGET_EMBED` to at least `EMBEDDING_BATCH_SIZE` (16) but below the chunk count (redeploy to
      apply): the document answers `parked` with `retryAfterMs`. It resumes after the reset when the client ticks again.
- [ ] 9 Streaming: an answer streams token by token (`: hb` heartbeats keep it open; cut at 300 s); aborting midway cancels
      the model call.
- [ ] 10 Cookie and address: the session cookie is `Secure`; the per-IP limit sees the visitor's address.
- [ ] 11 Gemini: an answer, an embedding and an OCR request work from the function's region with your key.
- [ ] 12 Scratch: `/tmp/enchanted-diary/ingest` (500 MB per instance) is cleaned after a document is read.
- [ ] 13 The book: open the PDF of a document over 4.5 MB (`GET /api/documents/:id/file` streams through the function);
      check Usage for Fast Origin Transfer. More than `FILE_READS_PER_DOC_PER_DAY` opens a day answers "the archive is full".
- [ ] 14 Stores: one Blob store for Production and a different one for Preview; no preview on the production database.
- [ ] 15 Cron: `curl -H "Authorization: Bearer $CRON_SECRET" https://<preview>/api/cron/retention` is 200 with counts (401
      without the header); after the first production deploy the Cron Jobs tab lists the job.
- [ ] 16 Missing assets: `/assets/does-not-exist.js` answers 404 without `Cache-Control: ... immutable`; if it carries it,
      drop `immutable` and lower `max-age` in `vercel.json`.
