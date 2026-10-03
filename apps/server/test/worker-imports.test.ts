import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * What a thread that only validates, parses or analyses a PDF loads. Every ingestion thread starts from worker.ts; the
 * model SDK (`@google/genai`), pdf-lib and the OCR task are for OCR threads only and must be reached through `import()`,
 * not through a static import: loading them costs about a second and 40 MB, on every thread of every upload.
 */

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const STATIC_IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^;'"]*?\s+from\s+)?['"]([^'"]+)['"]/gmu;

/** The packages and the files that a static import chain from `entry` reaches (type-only imports do not load anything). */
function staticGraph(entry: string): { packages: Set<string>; files: Set<string> } {
  const packages = new Set<string>();
  const files = new Set<string>();
  const visit = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(STATIC_IMPORT)) {
      const specifier = match[1] ?? '';
      if (specifier.startsWith('.')) {
        visit(path.resolve(path.dirname(file), specifier.replace(/\.js$/u, '.ts')));
      } else if (!specifier.startsWith('node:')) {
        packages.add(
          specifier.startsWith('@')
            ? specifier.split('/').slice(0, 2).join('/')
            : (specifier.split('/')[0] ?? ''),
        );
      }
    }
  };
  visit(entry);
  return { packages, files };
}

describe('the ingestion worker thread', () => {
  const { packages, files } = staticGraph(path.join(SRC, 'ingest', 'worker', 'worker.ts'));

  it('does not load the model SDK or pdf-lib to validate, parse or analyse a document', () => {
    expect(packages.has('@google/genai')).toBe(false);
    expect(packages.has('pdf-lib')).toBe(false);
    expect(packages.has('tesseract.js')).toBe(false);
  });

  it('does not reach the OCR task, the OCR providers or the shared Gemini module by a static import', () => {
    const reached = [...files].map((file) => path.relative(SRC, file).split(path.sep).join('/'));
    expect(reached).not.toContain('ingest/worker/ocr-task.ts');
    expect(reached).not.toContain('ocr/provider.ts');
    expect(reached).not.toContain('ocr/gemini.ts');
    expect(reached.filter((file) => file.startsWith('gemini/'))).toEqual([]);
  });

  it('does load pdf.js, which every one of its tasks needs (the check is looking at the right graph)', () => {
    expect(packages.has('pdfjs-dist')).toBe(true);
    expect([...files].some((file) => file.endsWith(path.join('pdf', 'load.ts')))).toBe(true);
  });

  it('reaches the OCR task by import(), where the OCR threads need it', () => {
    const text = readFileSync(path.join(SRC, 'ingest', 'worker', 'worker.ts'), 'utf8');
    expect(text).toMatch(/import\('\.\/ocr-task\.js'\)/u);
    expect(text).toMatch(/import\('\.\.\/\.\.\/ocr\/provider\.js'\)/u);
  });
});
