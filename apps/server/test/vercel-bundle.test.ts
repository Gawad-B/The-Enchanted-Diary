import { describe, expect, it } from 'vitest';
import {
  braceExpand,
  forbiddenIn,
  globToRegExp,
  packageOf,
  patternMatcher,
  problemsOf,
  sizeByPackage,
  staticPrefixes,
} from '../../../scripts/vercel-bundle-lib.js';

/* The pure parts of scripts/check-vercel-bundle.ts: what the patterns of vercel.json mean, and what is wrong with a bundle. */

describe('braceExpand', () => {
  it('expands groups, nested ones too, and leaves a pattern without braces alone', () => {
    expect(braceExpand('a/b')).toEqual(['a/b']);
    expect(braceExpand('x/{a,b}/y')).toEqual(['x/a/y', 'x/b/y']);
    expect(braceExpand('x/{a,b/{c,d}}')).toEqual(['x/a', 'x/b/c', 'x/b/d']);
    expect(braceExpand('{a,b}{1,2}')).toEqual(['a1', 'a2', 'b1', 'b2']);
    expect(braceExpand('unbalanced/{a,b')).toEqual(['unbalanced/{a,b']);
  });
});

describe('patternMatcher', () => {
  const match = patternMatcher(
    '{apps/server/dist/db/migrations/**,node_modules/pdfjs-dist/{cmaps,standard_fonts}/**,api/**/*.ts}',
  );

  it('matches the files under a directory pattern, at any depth', () => {
    expect(match('apps/server/dist/db/migrations/001_init.sql')).toBe(true);
    expect(match('node_modules/pdfjs-dist/cmaps/UniJIS-UTF16-H.bcmap')).toBe(true);
    expect(match('node_modules/pdfjs-dist/standard_fonts/FoxitSans.pfb')).toBe(true);
    expect(match('node_modules/pdfjs-dist/standard_fonts/deep/er/file.pfb')).toBe(true);
  });

  it('does not match anything else', () => {
    expect(match('node_modules/pdfjs-dist/legacy/build/pdf.mjs')).toBe(false);
    expect(match('apps/server/dist/db/migrate.js')).toBe(false);
    expect(match('node_modules/pdfjs-dist/cmapsX/a')).toBe(false);
  });

  it('treats `**/` as any number of directories, including none, and `*` as within one name', () => {
    expect(match('api/index.ts')).toBe(true);
    expect(match('api/a/b/c.ts')).toBe(true);
    expect(match('api/a/b/c.js')).toBe(false);
    expect(globToRegExp('a/*/c').test('a/b/c')).toBe(true);
    expect(globToRegExp('a/*/c').test('a/b/x/c')).toBe(false);
    expect(globToRegExp('a.b').test('aXb')).toBe(false); // a dot is a dot
  });

  it('is what excludeFiles says: a package and everything in it', () => {
    const excluded = patternMatcher('{node_modules/tesseract.js/**,node_modules/tesseract.js-core/**}');
    expect(excluded('node_modules/tesseract.js/src/index.js')).toBe(true);
    expect(excluded('node_modules/tesseract.js-core/tesseract-core.wasm')).toBe(true);
    expect(excluded('node_modules/tesseract.js-extras/x.js')).toBe(false);
  });
});

describe('staticPrefixes', () => {
  it('names the directories to look in', () => {
    expect(
      staticPrefixes('{apps/server/dist/db/migrations/**,node_modules/pdfjs-dist/{cmaps,wasm}/**}'),
    ).toEqual([
      'apps/server/dist/db/migrations',
      'node_modules/pdfjs-dist/cmaps',
      'node_modules/pdfjs-dist/wasm',
    ]);
    expect(staticPrefixes('node_modules/@napi-rs/{canvas,canvas-linux-x64-gnu}/**')).toEqual([
      'node_modules/@napi-rs/canvas',
      'node_modules/@napi-rs/canvas-linux-x64-gnu',
    ]);
  });
});

describe('packageOf', () => {
  it('is the package of the last node_modules segment, scoped names whole, and "app" for the repository’s own files', () => {
    expect(packageOf('node_modules/fastify/lib/server.js')).toBe('fastify');
    expect(packageOf('node_modules/@vercel/blob/dist/index.js')).toBe('@vercel/blob');
    expect(packageOf('node_modules/a/node_modules/b/index.js')).toBe('b');
    expect(packageOf('node_modules/@enchanted/shared/dist/index.js')).toBe('@enchanted/shared');
    expect(packageOf('apps/server/dist/app.js')).toBe('app');
    expect(packageOf('api/index.ts')).toBe('app');
  });
});

describe('forbiddenIn', () => {
  it('finds the local-model packages, the optional OCR engine, the development database and tooling', () => {
    const found = forbiddenIn([
      'fastify',
      'tesseract.js',
      'tesseract.js-core',
      '@tesseract.js-data/eng',
      '@huggingface/transformers',
      'onnxruntime-node',
      'onnxruntime-web',
      '@electric-sql/pglite',
      'sharp',
      'typescript',
      'vitest',
      '@playwright/test',
      'pdfjs-dist',
      '@napi-rs/canvas',
      '@google/genai',
    ]);
    expect(found).toEqual([
      'tesseract.js',
      'tesseract.js-core',
      '@tesseract.js-data/eng',
      '@huggingface/transformers',
      'onnxruntime-node',
      'onnxruntime-web',
      '@electric-sql/pglite',
      'sharp',
      'typescript',
      'vitest',
      '@playwright/test',
    ]);
    expect(forbiddenIn(['fastify', 'pdfjs-dist', '@napi-rs/canvas', 'pg'])).toEqual([]);
  });
});

describe('problemsOf', () => {
  const MB = 1024 * 1024;

  it('has nothing to say about a small bundle with everything in it', () => {
    expect(problemsOf({ totalBytes: 62 * MB, limitBytes: 250 * MB, forbidden: [], missing: [] })).toEqual([]);
  });

  it('says what is wrong: too big (at the limit already), what must not be there, what must', () => {
    expect(problemsOf({ totalBytes: 250 * MB, limitBytes: 250 * MB, forbidden: [], missing: [] })).toEqual([
      'the function is 250.0 MB, over the 250.0 MB limit',
    ]);
    expect(
      problemsOf({
        totalBytes: MB,
        limitBytes: 250 * MB,
        forbidden: ['tesseract.js'],
        missing: ['apps/server/dist/ingest/worker/worker.js'],
      }),
    ).toEqual([
      'tesseract.js is in the bundle and must not be',
      'apps/server/dist/ingest/worker/worker.js is not in the bundle and must be',
    ]);
  });
});

describe('sizeByPackage', () => {
  it('adds up the files of a package and orders the packages by size', () => {
    const sizes = new Map([
      ['node_modules/a/x.js', 10],
      ['node_modules/a/y.js', 30],
      ['node_modules/b/z.js', 25],
      ['apps/server/dist/app.js', 5],
    ]);
    expect(sizeByPackage(sizes)).toEqual([
      { name: 'a', bytes: 40, files: 2 },
      { name: 'b', bytes: 25, files: 1 },
      { name: 'app', bytes: 5, files: 1 },
    ]);
  });
});
