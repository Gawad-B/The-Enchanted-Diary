/*
 * Checks the Vercel function BEFORE it is deployed: traces what `api/index.ts` needs the way Vercel does (@vercel/nft, with the
 * `excludeFiles` of `vercel.json` as its `ignore`, which is how Vercel passes them), adds the `includeFiles`, and fails when
 *   - the unzipped function is not smaller than 250 MB (the Hobby limit),
 *   - a package that must not ship is in it (local models, the optional Tesseract engine, the development database, tooling),
 *   - a file the function needs at run time is not (the ingestion worker, the migrations, pdf.js's worker, fonts and cmaps,
 *     the native canvas, the compiled shared package).
 *
 *     npm run build -w @enchanted/shared && npm run build -w @enchanted/server && npm run check:vercel
 *
 * It is the last step of `npm run vercel-build`, so a deployment that would not work does not get built. It reads files and runs
 * no server, no model and no network.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeFileTrace } from '@vercel/nft';
import {
  forbiddenIn,
  megabytes,
  packageOf,
  patternMatcher,
  problemsOf,
  sizeByPackage,
  staticPrefixes,
} from './vercel-bundle-lib.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = 'api/index.ts';
const FUNCTION_KEY = 'api/**/*.ts';
/** The Hobby (and Pro) limit on an unzipped function, in bytes. */
const LIMIT_BYTES = 250 * 1024 * 1024;
const MAX_DURATION_SECONDS = 300;

interface FunctionConfig {
  maxDuration?: number;
  includeFiles?: string;
  excludeFiles?: string;
}

// `--config <file>` reads another vercel.json (to see what a change to includeFiles / excludeFiles would do).
const configArgument = process.argv.indexOf('--config');
const configFile =
  configArgument === -1
    ? path.join(ROOT, 'vercel.json')
    : path.resolve(process.argv[configArgument + 1] ?? '');
const vercelJson = JSON.parse(readFileSync(configFile, 'utf8')) as {
  functions?: Record<string, FunctionConfig>;
};
const config = vercelJson.functions?.[FUNCTION_KEY];
if (config === undefined) {
  console.error(`${path.basename(configFile)} has no "functions" entry for ${FUNCTION_KEY}`);
  process.exit(1);
}
if ((config.maxDuration ?? 0) > MAX_DURATION_SECONDS) {
  console.error(
    `maxDuration ${String(config.maxDuration)} is above the ${String(MAX_DURATION_SECONDS)} s of the Hobby plan`,
  );
  process.exit(1);
}

for (const built of ['apps/server/dist/vercel.js', 'packages/shared/dist/index.js']) {
  if (!existsSync(path.join(ROOT, built))) {
    console.error(
      `${built} does not exist: run "npm run build -w @enchanted/shared && npm run build -w @enchanted/server" first`,
    );
    process.exit(1);
  }
}

/** Every file under `directory` (repository-relative), without following links out of the tree. */
function walk(directory: string): string[] {
  const absolute = path.join(ROOT, directory);
  if (!existsSync(absolute)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(relative));
    else found.push(relative);
  }
  return found;
}

// --- what Vercel's tracer finds from the function ---
if (!existsSync(path.join(ROOT, ENTRY))) {
  console.error(
    `${ENTRY} does not exist: Vercel's file-system routing finds no function (see vercel.json "rewrites")`,
  );
  process.exit(1);
}
// Vercel hands `excludeFiles` to the tracer as `ignore`: what is excluded is not followed, so its own dependencies are not in
// the function either.
const isExcluded = config.excludeFiles === undefined ? () => false : patternMatcher(config.excludeFiles);
const traced = await nodeFileTrace([ENTRY], {
  base: ROOT,
  processCwd: ROOT,
  ts: true,
  mixedModules: true,
  ignore: (file: string) => isExcluded(file),
});
const files = new Set<string>(traced.fileList);
// What the TRACER finds, before `includeFiles` adds anything: the ingestion worker is started from a file URL, which the tracer
// finds through `new URL('./worker.js', import.meta.url)` in worker/entry.ts and the literal `import()` of vercel.ts
// (TRACE_WORKER). `includeFiles` names it too, which would hide the loss of both: it is checked here, on the traced list alone.
const tracedWorker = 'apps/server/dist/ingest/worker/worker.js';
const tracedWithoutIncludes = traced.fileList.has(tracedWorker);

// --- includeFiles are added, excludeFiles taken away (in that order, as Vercel does) ---
const included = new Set<string>();
if (config.includeFiles !== undefined) {
  const matches = patternMatcher(config.includeFiles);
  const prefixes = new Set(staticPrefixes(config.includeFiles));
  for (const prefix of prefixes) for (const file of walk(prefix)) if (matches(file)) included.add(file);
}
for (const file of included) files.add(file);
const excluded = new Set<string>();
for (const file of files) if (isExcluded(file)) excluded.add(file);
for (const file of excluded) files.delete(file);

// --- sizes: what is copied is the file a link points to, once ---
const sizes = new Map<string, number>();
const seen = new Set<string>();
for (const file of files) {
  let real: string;
  try {
    real = realpathSync(path.join(ROOT, file));
  } catch {
    continue; // listed by the tracer but not on disk (an optional dependency of another platform)
  }
  if (seen.has(real)) continue;
  seen.add(real);
  const stats = statSync(real);
  if (stats.isFile()) sizes.set(file, stats.size);
}
const totalBytes = [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0);
const packages = sizeByPackage(sizes);

// --- what must be there ---
// Every migration the source has must be in the function (an app that starts on a database that lacks one does not work).
const MIGRATIONS = readdirSync(path.join(ROOT, 'apps/server/src/db/migrations'))
  .filter((name) => name.endsWith('.sql'))
  .map((name) => `apps/server/dist/db/migrations/${name}`);
const REQUIRED = [
  'apps/server/dist/vercel.js',
  'apps/server/dist/ingest/worker/worker.js',
  ...MIGRATIONS,
  'packages/shared/dist/index.js',
  'node_modules/pdfjs-dist/legacy/build/pdf.mjs',
  'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
];
const REQUIRED_DIRECTORIES = [
  'node_modules/pdfjs-dist/standard_fonts/',
  'node_modules/pdfjs-dist/cmaps/',
  'node_modules/pdfjs-dist/wasm/',
];
const missing = [
  ...REQUIRED.filter((file) => !files.has(file)),
  ...REQUIRED_DIRECTORIES.filter((directory) => ![...files].some((file) => file.startsWith(directory))),
];
if (!tracedWithoutIncludes) {
  missing.push(
    `${tracedWorker} (the tracer does not find it any more: see TRACE_WORKER in apps/server/src/vercel.ts and worker/entry.ts; includeFiles alone would hide that)`,
  );
}
// The native canvas pdf.js draws with in Node (it loads it by a name the tracer cannot see, so `includeFiles` names it): the
// package, and the build for the platform of a Vercel function (Linux, x64, glibc).
// Where the function is built (Vercel, CI) the platform build must be there: a check that skips it would pass a deployment that
// cannot render pages. On a machine of another platform it is only reported.
const strict = process.env.VERCEL !== undefined || process.env.CI !== undefined;
for (const required of ['node_modules/@napi-rs/canvas/', 'node_modules/@napi-rs/canvas-linux-x64-gnu/']) {
  if (!existsSync(path.join(ROOT, required))) {
    if (strict) missing.push(`${required} (not installed in this build: the function renders pages with it)`);
    else console.log(`  (not checked: ${required} is not installed on this machine)`);
  } else if (![...files].some((file) => file.startsWith(required))) missing.push(required);
}

const forbidden = forbiddenIn(new Set([...files].map(packageOf)));
const problems = problemsOf({ totalBytes, limitBytes: LIMIT_BYTES, forbidden, missing });

// --- report ---
console.log(`Vercel function ${ENTRY}`);
console.log(
  `  traced ${String(traced.fileList.size)} files, +${String(included.size)} from includeFiles, -${String(excluded.size)} by excludeFiles: ${String(sizes.size)} files, ${megabytes(totalBytes)} MB of ${megabytes(LIMIT_BYTES)} MB`,
);
console.log('  largest packages:');
for (const entry of packages.slice(0, 12)) {
  console.log(`    ${megabytes(entry.bytes).padStart(7)} MB  ${entry.name} (${String(entry.files)} files)`);
}
if (excluded.size > 0) {
  const names = new Set([...excluded].map(packageOf));
  console.log(`  kept out by excludeFiles: ${[...names].sort().join(', ')}`);
}
if (traced.warnings.size > 0) {
  console.log(`  tracer warnings (${String(traced.warnings.size)}):`);
  for (const warning of [...traced.warnings].slice(0, 10))
    console.log(`    ${warning.message.split('\n')[0] ?? ''}`);
}
if (problems.length > 0) {
  console.error('\nThe function would not deploy as intended:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('  ok');
