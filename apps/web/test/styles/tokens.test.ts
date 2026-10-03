import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(path.join(import.meta.dirname, '../../src/styles/tokens.css'), 'utf8');

function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(css);
  if (!match?.[1]) throw new Error(`token --${name} is not a hex colour in tokens.css`);
  return match[1].toLowerCase();
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(token(foreground)), luminance(token(background))].sort((a, b) => b - a);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

describe('palette (global section I)', () => {
  it('defines every colour with the exact value', () => {
    const expected = {
      'ink-black': '#0b0907',
      soot: '#15100c',
      umber: '#3b2a1e',
      'umber-deep': '#241912',
      burgundy: '#5a1a22',
      'burgundy-deep': '#3a1016',
      parchment: '#e9dcc0',
      'parchment-dim': '#cbb890',
      'candle-gold': '#e0a84f',
      'gold-dim': '#a8782f',
      forest: '#2e3d2f',
      bronze: '#8a6a3e',
      'ink-wet': '#1d2230',
      'ink-dry': '#3b2c26',
      'ink-reply': '#2a1410',
      'ink-glow': '#f2c36b',
    };
    for (const [name, value] of Object.entries(expected)) expect(token(name), name).toBe(value);
  });
});

describe('contrast', () => {
  it.each([
    ['ink-wet', 'parchment'],
    ['ink-dry', 'parchment'],
    ['ink-reply', 'parchment'],
  ])('%s ink on parchment is at least 7:1', (ink, paper) => {
    expect(contrast(ink, paper)).toBeGreaterThanOrEqual(7);
  });

  it.each([
    ['parchment', 'ink-black'],
    ['parchment', 'soot'],
    ['parchment', 'burgundy'],
    ['parchment', 'burgundy-deep'],
    ['parchment', 'umber-deep'],
    ['parchment-dim', 'ink-black'],
    ['parchment-dim', 'soot'],
    ['candle-gold', 'ink-black'],
    ['candle-gold', 'burgundy-deep'],
    ['gold-dim', 'ink-black'],
    ['gold-dim', 'soot'],
    ['ink-glow', 'ink-black'],
  ])('%s text on %s is at least 4.5:1', (text, background) => {
    expect(contrast(text, background)).toBeGreaterThanOrEqual(4.5);
  });

  it('body copy on the dark stage clears 7:1', () => {
    expect(contrast('parchment', 'ink-black')).toBeGreaterThanOrEqual(7);
    expect(contrast('parchment-dim', 'ink-black')).toBeGreaterThanOrEqual(7);
  });

  it('knows bronze is decoration only (below 4.5:1 on the stage)', () => {
    expect(contrast('bronze', 'ink-black')).toBeLessThan(4.5);
  });
});

describe('font roles', () => {
  it('declares every role', () => {
    for (const role of ['quill', 'reply', 'title', 'fair', 'body', 'ui', 'mono']) {
      expect(css, role).toMatch(new RegExp(`--font-${role}:`));
    }
  });

  it('never lists the colour font in a root stack (it is applied only where a COLRv1 palette is set)', () => {
    const stacks = css.split('\n').filter((line) => /--font-(quill|reply|title):/.test(line));
    expect(stacks.length).toBe(3);
    for (const line of stacks) expect(line).not.toContain('Aref Ruqaa Ink');
  });

  it('defines a visible focus ring: 2px gold with a 2px dark offset', () => {
    expect(css).toMatch(/--focus-ring-width:\s*2px/);
    expect(css).toMatch(/--focus-ring-offset:\s*2px/);
    expect(css).toMatch(/--focus-ring-color:\s*var\(--candle-gold\)/);
  });
});
