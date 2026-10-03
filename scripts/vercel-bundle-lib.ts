/*
 * The pure parts of `check-vercel-bundle.ts`: what `includeFiles` and `excludeFiles` of `vercel.json` mean (brace and `**`
 * globs over repository-relative paths), which package a traced file belongs to, and the checks on the traced bundle.
 */

/** `{a,b}` groups expanded (nested groups too): `x/{a,b/{c,d}}` is `x/a`, `x/b/c`, `x/b/d`. */
export function braceExpand(pattern: string): string[] {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];
  let depth = 0;
  let close = -1;
  const commas: number[] = [];
  for (let i = open; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    } else if (char === ',' && depth === 1) commas.push(i);
  }
  if (close === -1) return [pattern];
  const bounds = [open, ...commas, close];
  const alternatives = bounds.slice(0, -1).map((start, index) => pattern.slice(start + 1, bounds[index + 1]));
  return alternatives.flatMap((alternative) =>
    braceExpand(`${pattern.slice(0, open)}${alternative}${pattern.slice(close + 1)}`),
  );
}

/** A glob without braces (`*` within a segment, `**` across segments, `?`) as an anchored regular expression. */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i] ?? '';
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          source += '(?:.*/)?'; // `**/` is zero or more directories
        } else source += '.*';
      } else source += '[^/]*';
    } else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/** A matcher for a vercel.json file pattern (braces allowed): true for a repository-relative path it names. */
export function patternMatcher(pattern: string): (relativePath: string) => boolean {
  const expressions = braceExpand(pattern).map(globToRegExp);
  return (relativePath) => expressions.some((expression) => expression.test(relativePath));
}

/** The directory every file the pattern can match lies under (the part before the first wildcard): where to look. */
export function staticPrefixes(pattern: string): string[] {
  return braceExpand(pattern).map((expanded) => {
    const wildcard = expanded.search(/[*?]/);
    const head = wildcard === -1 ? expanded : expanded.slice(0, wildcard);
    return head.includes('/') ? head.slice(0, head.lastIndexOf('/')) : '';
  });
}

/**
 * The package a file of the bundle belongs to: `fastify`, `@vercel/blob` (the last `node_modules/` segment, so a nested copy is
 * its own package), or `app` for the repository's own files (the compiled server, the shared package, the function).
 */
export function packageOf(relativePath: string): string {
  const marker = 'node_modules/';
  const at = relativePath.lastIndexOf(marker);
  if (at === -1) return 'app';
  const rest = relativePath.slice(at + marker.length).split('/');
  const first = rest[0] ?? '';
  if (first.startsWith('@')) return `${first}/${rest[1] ?? ''}`;
  return first;
}

/** Packages that must never be in the function: local models, the optional OCR engine, the dev database, tooling. */
export const FORBIDDEN_PACKAGES: readonly (string | RegExp)[] = [
  'tesseract.js',
  'tesseract.js-core',
  /^@tesseract\.js-data\//,
  /^@huggingface\//,
  /^onnxruntime/,
  /^@electric-sql\//,
  'sharp',
  /^@img\//,
  'typescript',
  'vitest',
  'tsx',
  'esbuild',
  'eslint',
  /^@playwright\//,
  'playwright',
  'playwright-core',
];

export function forbiddenIn(packages: Iterable<string>): string[] {
  return [...packages].filter((name) =>
    FORBIDDEN_PACKAGES.some((rule) => (typeof rule === 'string' ? rule === name : rule.test(name))),
  );
}

export interface PackageSize {
  name: string;
  bytes: number;
  files: number;
}

/** Sizes by package, biggest first. `sizes` maps a repository-relative path to its size in bytes. */
export function sizeByPackage(sizes: ReadonlyMap<string, number>): PackageSize[] {
  const totals = new Map<string, PackageSize>();
  for (const [file, bytes] of sizes) {
    const name = packageOf(file);
    const entry = totals.get(name) ?? { name, bytes: 0, files: 0 };
    entry.bytes += bytes;
    entry.files += 1;
    totals.set(name, entry);
  }
  return [...totals.values()].sort((a, b) => b.bytes - a.bytes);
}

export interface BundleFindings {
  totalBytes: number;
  limitBytes: number;
  forbidden: string[];
  missing: string[];
}

/** What is wrong with a bundle, as sentences (empty: nothing). */
export function problemsOf(findings: BundleFindings): string[] {
  const problems: string[] = [];
  if (findings.totalBytes >= findings.limitBytes) {
    problems.push(
      `the function is ${megabytes(findings.totalBytes)} MB, over the ${megabytes(findings.limitBytes)} MB limit`,
    );
  }
  for (const name of findings.forbidden) problems.push(`${name} is in the bundle and must not be`);
  for (const file of findings.missing) problems.push(`${file} is not in the bundle and must be`);
  return problems;
}

export const megabytes = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);
