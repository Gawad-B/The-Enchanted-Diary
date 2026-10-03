import { describe, expect, it } from 'vitest';
import { displayText, parseAnswer, plainText } from '../../src/ui/diary/format';

describe('displayText: the markers the model writes are not part of what is read', () => {
  it('removes [S1]-style markers with the space before them', () => {
    expect(displayText('It was founded in 1847 [S1].', false)).toBe('It was founded in 1847.');
    expect(displayText('A [S1][S2] and B [S3]', false)).toBe('A and B');
    expect(displayText('Done.[S12]', false)).toBe('Done.');
  });

  it('leaves other brackets alone', () => {
    expect(displayText('See [Figure 2] and [1] and [S]', false)).toBe('See [Figure 2] and [1] and [S]');
  });

  it('while the text streams, holds back an unfinished marker (an opener of up to six characters) until it resolves', () => {
    expect(displayText('It was founded [', true)).toBe('It was founded');
    expect(displayText('It was founded [S', true)).toBe('It was founded');
    expect(displayText('It was founded [S1', true)).toBe('It was founded');
    expect(displayText('It was founded [S123', true)).toBe('It was founded');
    expect(displayText('It was founded [S1]', true)).toBe('It was founded');
    // a bracket that cannot become a marker is text
    expect(displayText('It was [c', true)).toBe('It was [c');
    // and once the stream is over nothing is held back
    expect(displayText('It was founded [S', false)).toBe('It was founded [S');
  });

  it('holds back a single trailing asterisk while streaming (it may become a bold marker)', () => {
    expect(displayText('a *', true)).toBe('a ');
    expect(displayText('a **', true)).toBe('a **');
    expect(displayText('a *', false)).toBe('a *');
  });

  it('is stable as text streams: what is shown only ever grows by appending', () => {
    const full = 'The house was founded by Alaric Thornquist [S1]. He built a workroom [S2][S3].';
    let previous = '';
    for (let end = 1; end <= full.length; end += 1) {
      const shown = displayText(full.slice(0, end), true);
      expect(shown.startsWith(previous.trimEnd()), `${end}: "${previous}" -> "${shown}"`).toBe(true);
      previous = shown;
    }
    expect(displayText(full, false)).toBe('The house was founded by Alaric Thornquist. He built a workroom.');
  });
});

describe('parseAnswer: paragraphs, line breaks and bold, and nothing else', () => {
  it('splits paragraphs on blank lines and keeps single line breaks', () => {
    const paragraphs = parseAnswer('One.\nTwo.\n\nThree.', false);
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]?.inlines.map((inline) => inline.kind)).toEqual(['text', 'br', 'text']);
    expect(plainText(paragraphs)).toBe('One.\nTwo.\n\nThree.');
  });

  it('reads **bold**', () => {
    const [paragraph] = parseAnswer('The **Thornquist** house', false);
    expect(paragraph?.inlines).toEqual([
      { kind: 'text', text: 'The ', bold: false },
      { kind: 'text', text: 'Thornquist', bold: true },
      { kind: 'text', text: ' house', bold: false },
    ]);
  });

  it('an unmatched ** is text once the answer is final, and an open bold while it is still being written', () => {
    expect(plainText(parseAnswer('a **b', false))).toBe('a **b');
    expect(
      parseAnswer('a **b', false)[0]?.inlines.every((inline) => inline.kind === 'br' || !inline.bold),
    ).toBe(true);
    const streaming = parseAnswer('a **b', true)[0]?.inlines;
    expect(streaming).toEqual([
      { kind: 'text', text: 'a ', bold: false },
      { kind: 'text', text: 'b', bold: true },
    ]);
  });

  it('is plain text for everything else: HTML, markdown links and images are not parsed', () => {
    const malicious =
      '<img src=x onerror=alert(1)> ![x](http://evil/x.png) [click](javascript:alert(1)) <script>alert(2)</script>';
    const paragraphs = parseAnswer(malicious, false);
    expect(plainText(paragraphs)).toBe(malicious);
    for (const paragraph of paragraphs) {
      for (const inline of paragraph.inlines) expect(['text', 'br']).toContain(inline.kind);
    }
  });

  it('drops empty paragraphs and trims', () => {
    expect(parseAnswer('\n\n  \n\n', false)).toEqual([]);
    expect(plainText(parseAnswer('  Hello  ', false))).toBe('Hello');
  });
});
