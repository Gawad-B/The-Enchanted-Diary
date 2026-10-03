import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const stylesDir = path.join(import.meta.dirname, '../../src/styles');
const publicDir = path.join(import.meta.dirname, '../../public');
const css = readFileSync(path.join(stylesDir, 'fonts.css'), 'utf8');
const faces = css.match(/@font-face\s*\{[^}]*\}/g) ?? [];

describe('fonts.css', () => {
  it('declares the families the type roles need', () => {
    const families = new Set(faces.map((face) => /font-family:\s*'([^']+)'/.exec(face)?.[1]));
    expect([...families].sort()).toEqual(
      [
        'Amiri',
        'Aref Ruqaa',
        'Aref Ruqaa Ink',
        'Cormorant Infant',
        'EB Garamond',
        'La Belle Aurore',
        'Petit Formal Script',
        'Pinyon Script',
      ].sort(),
    );
  });

  it('uses font-display: swap on every face', () => {
    expect(faces.length).toBeGreaterThan(10);
    for (const face of faces) expect(face).toMatch(/font-display:\s*swap/);
  });

  it('loads only self-hosted woff2 files: no remote URLs', () => {
    expect(css).not.toMatch(/https?:\/\//);
    expect(css).not.toMatch(/\.woff['")]/);
    expect(css).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  });

  it('points every @fontsource url at a file that exists', () => {
    const urls = [...css.matchAll(/url\('(@fontsource\/[^']+)'\)/g)].map((match) => match[1] ?? '');
    expect(urls.length).toBeGreaterThan(10);
    for (const url of urls) {
      const file = path.join(import.meta.dirname, '../../../../node_modules', url);
      expect(existsSync(file), url).toBe(true);
    }
  });

  it('gives every Latin face a unicode-range so subsets do not override each other', () => {
    const fontsourceFaces = faces.filter((face) => face.includes('@fontsource/'));
    for (const face of fontsourceFaces) expect(face).toMatch(/unicode-range:/);
  });

  it('selects the COLRv1 and OpenType-SVG flavours of Aref Ruqaa Ink with tech()', () => {
    const ink = faces.find((face) => face.includes("'Aref Ruqaa Ink'")) ?? '';
    expect(ink).toMatch(
      /aref-ruqaa-ink-arabic-400-colrv1\.woff2'\)\s*format\('woff2'\)\s*tech\(color-COLRv1\)/,
    );
    expect(ink).toMatch(/aref-ruqaa-ink-arabic-400-svg\.woff2'\)\s*format\('woff2'\)\s*tech\(color-SVG\)/);
  });

  it('has the self-hosted Aref Ruqaa Ink files and the OFL licence in public/fonts', () => {
    for (const file of ['aref-ruqaa-ink-arabic-400-colrv1.woff2', 'aref-ruqaa-ink-arabic-400-svg.woff2']) {
      const target = path.join(publicDir, 'fonts', file);
      expect(existsSync(target), file).toBe(true);
      expect(statSync(target).size, file).toBeGreaterThan(10_000);
      // woff2 magic number
      expect(readFileSync(target).subarray(0, 4).toString('latin1'), file).toBe('wOF2');
    }
    expect(readFileSync(path.join(publicDir, 'fonts', 'OFL-aref-ruqaa-ink.txt'), 'utf8')).toContain(
      'SIL OPEN FONT LICENSE Version 1.1',
    );
  });

  it('defines one palette per ink state for the diary hand, with the five CPAL entries each', () => {
    for (const name of ['--diary-rising', '--diary-drying', '--diary-dry']) {
      const block = new RegExp(`@font-palette-values ${name}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
      expect(block, name).toContain("font-family: 'Aref Ruqaa Ink'");
      expect(block.match(/\b[0-4] #[0-9a-f]{6}/gi), name).toHaveLength(5);
    }
  });

  it('only applies the colour font where COLRv1 is supported', () => {
    expect(css).toMatch(/@supports font-tech\(color-COLRv1\)/);
  });
});
