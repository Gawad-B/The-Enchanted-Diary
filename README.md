# The Enchanted Diary

A 3D enchanted diary that answers questions about a PDF you offer it, with real retrieval-augmented answers that cite
their pages. You write to the book in ink; it writes back, and "Show me the truth" riffles to the page the answer came
from, with the passage glowing.

It is inspired by the Lab2 RAG notebook (bilingual EN/AR question answering over a university brochure) and improves on
it: scanned PDFs, hybrid retrieval, three refusal guards, a prompt-injection defence, and a real interface instead of a
notebook.

> **Demo, not production.** This is a demonstration deployment. It is not hardened against someone who sets out to
> exhaust the free tiers (Gemini quotas, Vercel Blob and Neon limits). Abuse and denial-of-service hardening are out of scope.
> Free-tier Gemini keys may let Google use what is sent to them; the app says so (`GEMINI_FREE_TIER`).

This is a fan-made concept. It is not an official Warner Bros. or Wizarding World product and uses no official
artwork, footage, music or dialogue.

## The experience

1. **Welcome.** The title and one button, "Start revealing the secrets". Behind it a book riffles its pages slowly.
2. **The riffle.** Pressing the button plays a long, fast riffle, then the book settles open on a blank diary page and the
   camera dives in.
3. **One-button upload.** The page offers "Offer a manuscript (PDF)" (plus a quieter "Use the sample manuscript"). Progress
   appears as ink on the page.
4. **Writing on the page.** You write directly on the page: no box, no send button; Enter commits. The ink sinks in and the
   reply writes itself in the same hand.
5. **One question per page.** Each question and answer gets its own page; a new question turns a leaf. Earlier exchanges stay
   on earlier pages as dried ink.
6. **Show me the truth.** Under an answer, a small handwritten link riffles the book to the cited PDF page, zooms in on the
   passage, and a ribbon brings you back to your page.

A simple 2D view (automatic when WebGL is unavailable, or on request) offers the same conversation as plain accessible UI.

## Features

- **Arabic and RTL.** Arabic interface, Arabic questions and answers, Arabic text extraction repair, right-to-left page
  order. In Arabic nothing appears in English (document quotes and proper names excepted).
- **Scanned PDFs.** Pages with no usable text are cut out of the PDF and read by Gemini OCR (`OCR_MODEL`), a few per request.
- **Hybrid retrieval.** pgvector similarity plus an IDF-weighted lexical ranking, fused with Reciprocal Rank Fusion.
- **Refusal guards.** A language-aware score floor, a yes/no grounding check (fails open), and the model's own
  `NOT_IN_DOCUMENT` sentinel: questions the document cannot answer are refused, in the question's language.
- **Prompt-injection defence.** Document text is quoted as data, delimiter spoofing is neutralised, and uncited sentences
  that are not statements about the document's silence are dropped from the answer.
- **Everything is Gemini.** Answers, embeddings and OCR use your `GEMINI_API_KEY`. No local models are needed.

## Quick start

Requires Node.js 22 (`.nvmrc`) and a Gemini API key (https://aistudio.google.com/apikey).

```sh
npm install
cp .env.example .env        # then set GEMINI_API_KEY=... in .env (never commit .env)
npm run dev                 # API on 8787, web on 5173
```

Open http://127.0.0.1:5173. With no `DATABASE_URL` the server uses an embedded PGlite database and stores uploads in
`.data/`, so nothing else has to be installed. For real PostgreSQL with pgvector: `npm run db:up` (Docker), then set
`DATABASE_URL=postgres://diary:diary@127.0.0.1:5433/diary` and run `npm run db:migrate`.

Production mode on one machine: `npm run build && SESSION_SECRET=$(openssl rand -hex 32) npm start`.

All settings are documented in `.env.example`; real environment variables win over `.env`.

## Testing

| Command                | What it runs                                                                  |
| ---------------------- | ----------------------------------------------------------------------------- |
| `npm test`             | Unit and integration suites (shared, server, web); no network, no Gemini      |
| `npm run typecheck`    | TypeScript (strict) for every workspace and `api/`                            |
| `npm run lint`         | ESLint                                                                        |
| `npm run format:check` | Prettier                                                                      |
| `npm run test:pg`      | Real-PostgreSQL gate (starts the Docker database; leases, locks, migrations)  |
| `npm run e2e`          | Playwright journeys, desktop and mobile, against a deterministic server       |
| `npm run test:evals`   | Live RAG evals against Gemini (`GEMINI_API_KEY`; spends real requests)        |
| `npm run calibrate`    | Re-measure the evidence gate thresholds (live, a few requests)                |
| `npm run fixtures`     | Regenerate the test PDFs in `fixtures/`                                       |

## Deploying to Vercel

The app is a static Vite SPA plus one Vercel Function (`api/index.ts`, the whole Fastify app) on the Hobby plan, a Neon
Postgres with pgvector (Marketplace), and a private Vercel Blob store for the PDFs. `vercel.json` carries the build, the
function's packaging, the rewrites, the security headers and one daily retention cron. `npm run vercel-build` builds
everything, checks the function bundle (`npm run check:vercel`: under 250 MB, nothing forbidden, nothing missing) and only
then applies migrations.

Step-by-step setup, environment variables, per-environment databases and the preview-deploy checklist are in
**[docs/VERCEL_CHECKLIST.md](docs/VERCEL_CHECKLIST.md)**. Key facts:

- `engines.node` is `22.x`; this field, not the dashboard, selects the Node version.
- Required variables: `SESSION_SECRET` (32+ random characters), `GEMINI_API_KEY`, `STORAGE_PROVIDER=vercel-blob`,
  `CRON_SECRET`; `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN` come from the integrations.
- Documents are read in short **ticks** the browser keeps calling, so nothing depends on a process staying alive; a daily
  Gemini quota that runs out parks a document until the quota resets instead of failing it.
- Limits: 300 pages (`MAX_PAGES`), 20 MB uploads with Blob (`MAX_UPLOAD_MB`), documents kept 24 h sliding and 72 h at most,
  Gemini daily budgets (`GEMINI_DAILY_BUDGET_*`) set under your real quotas, Blob budgets (`BLOB_*`, `FILE_READS_PER_DOC_PER_DAY`).
- Previews must never share production's database or Blob store (the server refuses to migrate or expire data outside
  production unless `ALLOW_PREVIEW_DATA=true`).
- Deploy by git push or a remote build. The Vercel CLI ignores `.gitignore`; `.vercelignore` keeps `.env` and `.data/`
  out, and `vercel deploy --prebuilt` must not be used.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it is built.
- [docs/VERCEL_CHECKLIST.md](docs/VERCEL_CHECKLIST.md): deployment checklist.

## Layout

```
packages/shared   zod API contract, error codes, text normalisation
api               the Vercel function entry (api/index.ts)
apps/server       Fastify API: sessions, ingestion in ticks, OCR, embeddings, RAG
apps/web          Vite + React + React Three Fiber experience with a 2D view
e2e               Playwright specs
scripts           fixtures, bundle check, calibration
fixtures          generated test PDFs
```

## License

License to be decided by the owner (placeholder: all rights reserved until then).
