import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const tokens = readFileSync(path.join(import.meta.dirname, '../../src/styles/tokens.css'), 'utf8');
const sheet = readFileSync(path.join(import.meta.dirname, '../../src/styles/fallback.css'), 'utf8');

function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(tokens);
  if (!match?.[1]) throw new Error(`token --${name} is not a hex colour`);
  return match[1];
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function ratio(foreground: string, background: string): number {
  const [light, dark] = [luminance(token(foreground)), luminance(token(background))].sort((a, b) => b - a);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

describe('the colours the simple view uses', () => {
  it.each([
    ['ink-wet', 'parchment', 7], // the question
    ['ink-reply', 'parchment', 7], // the answer, the upload card
    ['ink-dry', 'parchment', 7], // the diary's waiting line, placeholders
    ['burgundy', 'parchment', 7], // "Show me the truth"
    ['parchment', 'ink-black', 7], // the title on the stage
    ['parchment', 'soot', 7], // the truth dialog
    ['parchment-dim', 'soot', 4.5],
    ['parchment-dim', 'ink-black', 4.5], // the quiet tools under the cards
    ['candle-gold', 'ink-black', 4.5],
    ['parchment', 'burgundy-deep', 4.5], // the buttons
    ['ink-reply', 'parchment', 4.5],
  ])('%s on %s is at least %s:1', (foreground, background, minimum) => {
    expect(ratio(foreground, background)).toBeGreaterThanOrEqual(minimum);
  });

  it('keeps every button target at 44 px and respects the safe areas', () => {
    expect(sheet).toMatch(/min-height:\s*44px/u);
    expect(sheet).toMatch(/safe-area-inset-bottom/u);
  });
});
