/*
 * Checks the BUILT web client (apps/web/dist) before it is deployed:
 *   - no Gemini key pattern (AIza...), no other provider key, no private-key block, no secret value copied from a local .env;
 *   - no server-only module or secret variable name (the server's packages, GEMINI_API_KEY, SESSION_SECRET, ...);
 *   - the Content-Security-Policy header in vercel.json is exactly the one the server sends (http/security.ts, blob mode).
 *
 *     npm run build -w @enchanted/web && npm run check:client
 *
 * It reads files and runs no server and no network. Exit code 1 lists every finding (never a secret's value).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentSecurityPolicy } from '../apps/server/src/http/security.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = path.join(ROOT, 'apps/web/dist');
const TEXT_FILE = /\.(?:js|mjs|css|html|json|map|txt|webmanifest|svg)$/u;

const SECRET_PATTERNS: readonly [string, RegExp][] = [
  ['Gemini / Google API key', /AIza[0-9A-Za-z_-]{30,}/u],
  ['Anthropic / OpenAI style key', /sk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/u],
  ['Vercel Blob token', /vercel_blob_rw_[A-Za-z0-9_]+/u],
  // A header with a base64 body after it (a library that merely names the header in a pattern is not a key).
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----\s*[A-Za-z0-9+/=\s]{100,}/u],
  ['database URL with a password', /postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@/u],
];

/** Names that only the server may know: its packages and its secret variables. */
const SERVER_ONLY: readonly string[] = [
  'GEMINI_API_KEY',
  'SESSION_SECRET',
  'DATABASE_URL',
  'CRON_SECRET',
  'BLOB_READ_WRITE_TOKEN',
  '@google/genai',
  '@napi-rs/canvas',
  '@electric-sql/pglite',
  'pdfjs-dist/legacy',
  'tesseract.js',
  'onnxruntime-node',
  'fastify',
  '@enchanted/server',
];

/**
 * Library code that names a server-side thing without holding it: @vercel/blob's browser client names the token variable in
 * an error message, and pdf.js names the optional Node canvas it never loads in a browser.
 */
const NAMED_BY_LIBRARIES: Record<string, RegExp> = {
  BLOB_READ_WRITE_TOKEN: /vercel\.com\/api\/blob/u,
  '@napi-rs/canvas': /pdf\.js|pdfjs|PDF\.js/u,
};

/** .env values that must never reach the client (secret-looking keys only, and only values long enough to be one). */
function envSecrets(): string[] {
  const file = path.join(ROOT, '.env');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => /^\s*([A-Z0-9_]*(?:KEY|SECRET|TOKEN|URL|PASSWORD)[A-Z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line))
    .flatMap((match) => {
      const value = (match?.[2] ?? '').replace(/^["']|["']$/gu, '');
      return value.length >= 12 && !/^https?:\/\/(?:localhost|127\.)/u.test(value) ? [value] : [];
    });
}

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const problems: string[] = [];
if (!existsSync(DIST)) {
  console.error('apps/web/dist does not exist: run "npm run build -w @enchanted/web" first');
  process.exit(1);
}

const secrets = envSecrets();
let scanned = 0;
for (const file of walk(DIST)) {
  const relative = path.relative(ROOT, file);
  if (path.basename(file).startsWith('.env'))
    problems.push(`${relative}: an env file is in the build output`);
  if (!TEXT_FILE.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  scanned += 1;
  for (const [label, pattern] of SECRET_PATTERNS) {
    if (pattern.test(text)) problems.push(`${relative}: ${label}`);
  }
  for (const name of SERVER_ONLY) {
    if (text.includes(name) && !NAMED_BY_LIBRARIES[name]?.test(text))
      problems.push(`${relative}: server-only name "${name}"`);
  }
  if (secrets.some((value) => text.includes(value))) problems.push(`${relative}: a value from .env`);
}

// The CSP of vercel.json is the one the server sends in blob mode (http/security.ts).
const vercel = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')) as {
  headers?: { headers: { key: string; value: string }[] }[];
};
const csp = vercel.headers
  ?.flatMap((rule) => rule.headers)
  .find((header) => header.key.toLowerCase() === 'content-security-policy')?.value;
const expected = contentSecurityPolicy({ blob: true });
if (csp === undefined) problems.push('vercel.json has no Content-Security-Policy header');
else if (csp !== expected) {
  problems.push(
    `vercel.json CSP differs from http/security.ts\n    vercel.json: ${csp}\n    server:      ${expected}`,
  );
}

if (problems.length > 0) {
  console.error(`check-client-bundle: ${String(problems.length)} problem(s) in ${String(scanned)} files\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`check-client-bundle: ${String(scanned)} files in apps/web/dist are clean; the CSP matches.`);
