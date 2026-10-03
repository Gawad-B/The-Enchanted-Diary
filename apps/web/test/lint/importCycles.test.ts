import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/*
 * A scripted stand-in for eslint-plugin-import's `import/no-cycle` (the plugin is not installed): no RUNTIME import
 * cycle may exist under apps/web/src. A cycle is harmless only while nothing reads an imported `const` at module
 * level; the day something does, the browser throws a temporal-dead-zone ReferenceError that vitest (which loads the
 * modules in another order) never sees. Type-only imports are erased and lazy `import()` runs after the importer has
 * finished evaluating, so neither counts.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) found.push(path);
  }
  return found;
}

/** The module a relative specifier names, as an absolute path of a file that exists, or null (a package, a stylesheet). */
function resolveImport(from: string, specifier: string, files: ReadonlySet<string>): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(from), specifier);
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
    base,
  ]) {
    if (files.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Whether an import or an `export ... from` survives compilation. Only the statement-level `type` keyword erases it;
 * with `verbatimModuleSyntax` even `import { type A } from './x'` stays, as a bare load of './x'.
 */
function isRuntime(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isImportDeclaration(node)) return node.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword;
  return !node.isTypeOnly;
}

export function runtimeImportGraph(root: string): Map<string, string[]> {
  const files = sourceFiles(root);
  const known = new Set(files);
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const edges: string[] = [];
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier) || !isRuntime(statement)) continue;
      const target = resolveImport(file, specifier.text, known);
      if (target) edges.push(target);
    }
    graph.set(file, edges);
  }
  return graph;
}

/** Strongly connected components with more than one module, or a module that imports itself (Tarjan). */
export function findCycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const visit = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node) ?? 0, low.get(next) ?? 0));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node) ?? 0, index.get(next) ?? 0));
      }
    }
    if (low.get(node) === index.get(node)) {
      const component: string[] = [];
      for (;;) {
        const member = stack.pop();
        if (member === undefined) break;
        onStack.delete(member);
        component.push(member);
        if (member === node) break;
      }
      if (component.length > 1 || (graph.get(node) ?? []).includes(node)) cycles.push(component.reverse());
    }
  };
  for (const node of graph.keys()) if (!index.has(node)) visit(node);
  return cycles;
}

describe('runtime import cycles under apps/web/src', () => {
  it('there are none', () => {
    const graph = runtimeImportGraph(SRC);
    expect(graph.size).toBeGreaterThan(50);
    const cycles = findCycles(graph).map((cycle) => cycle.map((file) => file.slice(SRC.length + 1)));
    expect(cycles, `import cycle(s): ${JSON.stringify(cycles)}`).toEqual([]);
  });

  describe('the scan itself', () => {
    it('finds a cycle between two modules, a longer one, and a module importing itself', () => {
      const graph = new Map<string, string[]>([
        ['a', ['b']],
        ['b', ['a']],
        ['c', ['d']],
        ['d', ['e']],
        ['e', ['c', 'f']],
        ['f', []],
        ['g', ['g']],
        ['h', ['f']],
      ]);
      const cycles = findCycles(graph).map((cycle) => [...cycle].sort());
      expect(cycles).toContainEqual(['a', 'b']);
      expect(cycles).toContainEqual(['c', 'd', 'e']);
      expect(cycles).toContainEqual(['g']);
      expect(cycles).toHaveLength(3);
    });

    it('finds a real cycle that one side closes with an all-inline-type import', () => {
      const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'cycles-'));
      try {
        writeFileSync(
          join(directory, 'x.ts'),
          "import { y } from './y';\nexport const x = y;\nexport type X = number;\n",
        );
        writeFileSync(join(directory, 'y.ts'), "import { type X } from './x';\nexport const y: X = 1;\n");
        writeFileSync(join(directory, 'z.ts'), "import type { X } from './x';\nexport const z: X = 1;\n");
        const graph = runtimeImportGraph(directory);
        const cycles = findCycles(graph).map((cycle) => cycle.map((file) => basename(file)).sort());
        expect(cycles).toEqual([['x.ts', 'y.ts']]); // and z.ts's `import type` closes nothing
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it('reads real import statements: a type-only import is not an edge, a runtime one is', () => {
      const parse = (code: string): boolean => {
        const source = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true);
        const [statement] = source.statements;
        if (!statement || (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement))) {
          throw new Error('not an import');
        }
        return isRuntime(statement);
      };
      expect(parse("import { a } from './x';")).toBe(true);
      expect(parse("import type { A } from './x';")).toBe(false);
      // verbatimModuleSyntax keeps these as `import {} from './x'` (a module load that takes part in cycles)
      expect(parse("import { type A, type B } from './x';")).toBe(true);
      expect(parse("import { type A } from './x';")).toBe(true);
      expect(parse("import X, { type A } from './x';")).toBe(true);
      expect(parse("import { type A, b } from './x';")).toBe(true);
      expect(parse("import './x';")).toBe(true);
      expect(parse("export { a } from './x';")).toBe(true);
      expect(parse("export { type A } from './x';")).toBe(true);
      expect(parse("export type * from './x';")).toBe(false);
      expect(parse("export type { A } from './x';")).toBe(false);
      expect(parse("export * from './x';")).toBe(true);
    });
  });
});
