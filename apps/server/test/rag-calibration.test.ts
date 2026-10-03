import { describe, expect, it } from 'vitest';
import {
  computeThresholds,
  quantile,
  renderGenerated,
  retrievalBenchmark,
  type Measure,
} from '../src/rag/calibration.js';

/*
 * The arithmetic of `npm run calibrate`, on made-up measures: the thresholds it computes, the benchmark and the generated file.
 * (The measuring itself needs the live embedding model: test/evals/rag-calibration.eval.test.ts.)
 */

const measure = (
  kind: Measure['kind'],
  sameLanguage: boolean | null,
  topCosine: number | null,
  extra: Partial<Measure> = {},
): Measure => ({
  kind,
  sameLanguage,
  topCosine,
  lexicalHit: false,
  lexicalCoverage: 0,
  identifierHit: false,
  properNameHit: false,
  ...extra,
});

describe('computeThresholds', () => {
  const measures: Measure[] = [
    // same language: unrelated up to 0.59, answerable without a word from 0.67
    measure('unrelated', true, 0.55),
    measure('unrelated', true, 0.59),
    measure('answerable', true, 0.67),
    measure('answerable', true, 0.72),
    measure('answerable', true, 0.8, { lexicalHit: true, lexicalCoverage: 1 }),
    measure('trap', true, 0.714),
    // across languages: unrelated up to 0.577, answerable from 0.705
    measure('unrelated', false, 0.5),
    measure('unrelated', false, 0.577),
    measure('answerable', false, 0.705),
    measure('answerable', false, 0.75),
    measure('trap', false, 0.686),
    // generic shared words: an unrelated question covers 0.42, an answerable one 0.66
    measure('unrelated', true, 0.575, { lexicalHit: true, lexicalCoverage: 0.42 }),
    measure('answerable', true, 0.73, { lexicalHit: true, lexicalCoverage: 0.66 }),
  ];
  const report = computeThresholds(measures);

  it('puts each floor just above the highest unrelated question of ITS language group and well clear of the lowest answerable one, independently', () => {
    // same language: unrelated up to 0.59, answerable from 0.67: 0.03 above the unrelated one (0.62), 0.05 under the answerable one
    expect(report.thresholds.sameLanguageFloor).toBeCloseTo(0.62, 2);
    // across languages: unrelated up to 0.577, answerable from 0.705: 0.03 above (0.607 rounded down)
    expect(report.thresholds.floor).toBeCloseTo(0.6, 2);
    expect(report.sameLanguage.separable).toBe(true);
    expect(report.sameLanguage.aboveUnrelated).toBeGreaterThanOrEqual(0.02);
    expect(report.sameLanguage.belowAnswerable).toBeGreaterThanOrEqual(0.03);
    expect(report.crossLanguage.separable).toBe(true);
    expect(report.crossLanguage.belowAnswerable).toBeGreaterThanOrEqual(0.03);
    expect(report.sameLanguage.losses + report.crossLanguage.losses).toBe(0);
    expect(report.checks).toEqual({ ok: true, problems: [] });
  });

  it('stays at least 0.03 clear of the lowest answerable question when the gap is narrow: unrelated questions leak to guards 2 and 3 instead', () => {
    // the real data of the first calibration: the highest unrelated question 0.581, the lowest answerable one 0.608
    const narrow = computeThresholds([
      measure('unrelated', true, 0.581),
      measure('unrelated', true, 0.55),
      measure('answerable', true, 0.608),
      measure('answerable', true, 0.7),
    ]);
    expect(narrow.thresholds.sameLanguageFloor).toBeLessThanOrEqual(0.57); // 0.608 - 0.03 = 0.578, rounded DOWN
    expect(narrow.sameLanguage.belowAnswerable).toBeGreaterThanOrEqual(0.03);
    expect(narrow.sameLanguage.leaks).toBe(1);
    expect(narrow.sameLanguage.losses).toBe(0);
    expect(narrow.notes.join(' ')).toContain('leak to guards 2 and 3');
    expect(narrow.checks.ok).toBe(true);
    // a gap under 0.01 does not push the floor onto the answerable question (the midpoint rule rounded to 0.61 for 0.604 / 0.608)
    const razor = computeThresholds([measure('unrelated', true, 0.604), measure('answerable', true, 0.608)]);
    expect(razor.thresholds.sameLanguageFloor).toBeLessThan(0.58);
  });

  it('fails its own check when a floor cannot keep the margin, instead of shipping it', () => {
    // the floor is clamped at 0.3: an answerable question at 0.32 is only 0.02 above it
    const tight = computeThresholds([measure('unrelated', true, 0.1), measure('answerable', true, 0.32)]);
    expect(tight.checks.ok).toBe(false);
    expect(tight.checks.problems.join(' ')).toContain('at least 0.03 is required');
  });

  it('reports what the floors would lose on questions they had not seen (leave one out, leave one document out)', () => {
    const measures = [
      measure('unrelated', true, 0.62, { doc: 'a' }),
      measure('answerable', true, 0.64, { doc: 'a' }),
      measure('answerable', true, 0.8, { doc: 'b' }),
      measure('answerable', true, 0.85, { doc: 'b' }),
    ];
    const robust = computeThresholds(measures);
    // without the 0.64 question the floor rises to 0.65 and would stop it; without document "a" nothing changes for "b"
    expect(robust.robustness.leaveOneOut.join(' ')).toContain('0.64');
    expect(robust.robustness.leaveOneDocumentOut.join(' ')).toContain('0.64');
    expect(robust.checks.ok).toBe(true); // informational: the in-sample floors are fine
  });

  it('may give the cross-language floor the LOWER value, and the strong marks follow their group', () => {
    const reversed = computeThresholds([
      measure('unrelated', true, 0.7),
      measure('answerable', true, 0.8),
      measure('unrelated', false, 0.5),
      measure('answerable', false, 0.6),
    ]);
    expect(reversed.thresholds.sameLanguageFloor).toBeGreaterThan(reversed.thresholds.floor);
    expect(report.thresholds.strong).toBeGreaterThan(0.714); // above the highest trap of the same-language group
    expect(report.thresholds.crossLanguageStrong).toBeGreaterThan(0.686);
    expect(report.thresholds.strong).toBeGreaterThan(report.thresholds.sameLanguageFloor);
  });

  it('puts each strong mark just above the highest trap of its group, so that as many answerable questions as possible read strong', () => {
    expect(report.thresholds.strong).toBeCloseTo(0.714 + 0.02, 2);
    expect(report.thresholds.crossLanguageStrong).toBeCloseTo(0.686 + 0.02, 2);
    // an answerable question just under the lower quartile still reads strong when no trap is near it
    const open = computeThresholds([
      measure('unrelated', false, 0.5),
      measure('trap', false, 0.6),
      measure('answerable', false, 0.68),
      measure('answerable', false, 0.8),
      measure('answerable', false, 0.85),
      measure('answerable', false, 0.9),
    ]);
    expect(open.thresholds.crossLanguageStrong).toBeCloseTo(0.62, 2);
    // no trap: the lower quartile of the answerable ones, else the floor plus a margin
    const noTrap = computeThresholds([
      measure('unrelated', false, 0.5),
      measure('answerable', false, 0.7),
      measure('answerable', false, 0.8),
    ]);
    expect(noTrap.thresholds.crossLanguageStrong).toBeGreaterThan(noTrap.thresholds.floor);
  });

  it('puts the coverage threshold just above the generic words of an unrelated question, and not above those of an answerable one', () => {
    // the unrelated question covers 0.42 with generic words and sits under the floor: from 0.45 on its word is no evidence and the
    // gate stops it; the answerable one (0.66) is evidence from any coverage up to 0.66 on, and passes on its cosine anyway
    expect(report.thresholds.informativeCoverage).toBeGreaterThan(0.42);
    expect(report.thresholds.informativeCoverage).toBeLessThanOrEqual(0.66);
    expect(report.coverage).toMatchObject({
      genericMax: 0.42,
      answerableMin: 0.66,
      separable: true,
      lost: 0,
    });
    expect(report.coverage.stopped).toBeGreaterThanOrEqual(4);
  });

  it('does not let a generic word of an unrelated question keep it past the gate just because answerable ones share words too', () => {
    // "the capital of Peru" asked of a brochure that says "the capital city": cosine 0.58, 0.42 of the question covered by words.
    // Low-coverage answerable questions (0.07 .. 0.13) pass on their cosines (0.68 and more), so no veto is needed for them.
    const brochure = computeThresholds([
      measure('unrelated', true, 0.58, { lexicalHit: true, lexicalCoverage: 0.42 }),
      measure('unrelated', true, 0.55),
      measure('answerable', true, 0.68, { lexicalHit: true, lexicalCoverage: 0.07 }),
      measure('answerable', true, 0.72, { lexicalHit: true, lexicalCoverage: 0.13 }),
      measure('answerable', true, 0.8, { lexicalHit: true, lexicalCoverage: 0.5 }),
    ]);
    expect(brochure.thresholds.informativeCoverage).toBeGreaterThan(0.42);
    expect(brochure.coverage).toMatchObject({ lost: 0 });
    expect(brochure.coverage.stopped).toBe(2);
    expect(brochure.thresholds.sameLanguageFloor).toBeGreaterThan(0.58);
    expect(brochure.thresholds.sameLanguageFloor).toBeLessThan(0.68);
  });

  it('puts the coverage above the generic words of an unrelated question even when the floor would not stop it anyway (ruling 3)', () => {
    // the real data of the second calibration: "the capital of Peru" on the brochure covers 0.42 with generic words and scores 0.581,
    // above a floor that has to stay 0.03 under the lowest answerable question (0.608): the cosine cannot stop it, but a shared
    // generic word must not be what lets it through either
    const real = computeThresholds([
      measure('unrelated', true, 0.581, { lexicalHit: true, lexicalCoverage: 0.417 }),
      measure('unrelated', true, 0.5714),
      measure('unrelated', true, 0.557, { lexicalHit: true, lexicalCoverage: 0.157 }),
      measure('answerable', true, 0.608, { lexicalHit: true, lexicalCoverage: 0.066 }),
      measure('answerable', true, 0.7),
    ]);
    expect(real.thresholds.informativeCoverage).toBeGreaterThan(0.417);
    expect(real.coverage.lost).toBe(0);
  });

  it('does not count a question with an informative shared word as one the floor sees', () => {
    const withName = computeThresholds([
      measure('unrelated', true, 0.5),
      measure('answerable', true, 0.8),
      // a low-cosine answerable question whose shared word is a name: not exposed, so it cannot drag the floor down
      measure('answerable', true, 0.4, { lexicalHit: true, lexicalCoverage: 0.1, properNameHit: true }),
    ]);
    expect(withName.thresholds.sameLanguageFloor).toBeCloseTo(0.53, 2); // 0.03 above the unrelated one: the 0.4 question is not seen
  });

  it('counts the questions that are not about the document and pass the gate without the cosine test, by what exempts them (review NB-10)', () => {
    const exempt = computeThresholds([
      measure('unrelated', true, 0.5),
      measure('answerable', true, 0.8),
      // a name: "Who is the President of France?" on a brochure that capitalises "President"
      measure('unrelated', true, 0.52, {
        lexicalHit: true,
        lexicalCoverage: 0.2,
        properNameHit: true,
        doc: 'tips',
        question: 'Who is the President of France?',
      }),
      measure('unrelated', true, 0.51, { lexicalHit: true, lexicalCoverage: 0.1, identifierHit: true }),
      // generic words that cover enough of the question (the default coverage mark is 0.5)
      measure('unrelated', true, 0.5, { lexicalHit: true, lexicalCoverage: 0.9 }),
      measure('trap', true, 0.6, { lexicalHit: true, lexicalCoverage: 0.2, properNameHit: true }),
      // not counted: an answerable one, and an unrelated one the gate does see (no informative word)
      measure('answerable', true, 0.4, { lexicalHit: true, lexicalCoverage: 0.1, properNameHit: true }),
      measure('unrelated', true, 0.45, { lexicalHit: true, lexicalCoverage: 0.1 }),
    ]);
    expect(exempt.exempt.unrelated.name).toBe(1);
    expect(exempt.exempt.unrelated.identifier).toBe(1);
    expect(exempt.exempt.trap.name).toBe(1);
    expect(exempt.exempt.questions).toEqual([
      'tips: Who is the President of France? [name]',
      '?: (question not recorded) [identifier]',
      expect.stringContaining('[sharedWords]') as string,
    ]);
    // and the generated file says so, next to the leak counts that do not include them
    const header = renderGenerated('m', 3, exempt, '2026-01-01');
    expect(header).toContain('past the gate without the cosine test');
    expect(header).toContain('(1 on a name, 1 on an identifier,');
    expect(header).toContain('Who is the President of France? [name]');
  });

  it('reports no exemptions when the labelled questions have none', () => {
    const none = computeThresholds([measure('unrelated', true, 0.5), measure('answerable', true, 0.8)]);
    expect(none.exempt).toEqual({
      unrelated: { name: 0, identifier: 0, sharedWords: 0 },
      trap: { name: 0, identifier: 0, sharedWords: 0 },
      questions: [],
    });
  });

  it('never loses an answerable question when the classes overlap: the floor stays clear of the lowest answerable one', () => {
    const overlap = computeThresholds([
      measure('unrelated', true, 0.7),
      measure('answerable', true, 0.65),
      measure('answerable', true, 0.8),
    ]);
    expect(overlap.sameLanguage.separable).toBe(false);
    expect(overlap.thresholds.sameLanguageFloor).toBeLessThanOrEqual(0.62);
    expect(overlap.sameLanguage.losses).toBe(0);
    expect(overlap.sameLanguage.leaks).toBe(1);
    expect(overlap.notes.join(' ')).toContain('leak to guards 2 and 3');
    expect(overlap.checks.ok).toBe(true);
  });

  it('copes with a side that has no data, with a note, instead of inventing a margin', () => {
    const onlyUnrelated = computeThresholds([measure('unrelated', true, 0.5)]);
    expect(onlyUnrelated.thresholds.sameLanguageFloor).toBeCloseTo(0.53, 2);
    expect(onlyUnrelated.sameLanguage.belowAnswerable).toBeNull();
    const nothing = computeThresholds([]);
    expect(nothing.thresholds.floor).toBe(0.6);
    expect(nothing.thresholds.informativeCoverage).toBe(0.5);
    expect(nothing.notes.length).toBeGreaterThan(0);
  });

  it('keeps the thresholds in a sane order', () => {
    for (const t of [report.thresholds]) {
      expect(t.strong).toBeGreaterThan(t.sameLanguageFloor);
      expect(t.crossLanguageStrong).toBeGreaterThan(t.floor);
      expect(t.informativeCoverage).toBeGreaterThanOrEqual(0.3);
      expect(t.informativeCoverage).toBeLessThanOrEqual(0.7);
    }
  });
});

describe('quantile', () => {
  it('interpolates, and answers null for no data', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([5], 0.25)).toBe(5);
    expect(quantile([], 0.5)).toBeNull();
  });
});

describe('retrievalBenchmark', () => {
  it('reports hit@1 and hit@6 per channel, for all questions and for the same-language and cross-language ones', () => {
    const rows = retrievalBenchmark([
      { crossLanguage: false, ranks: { semantic: 1, lexical: 1, hybrid: 1 } },
      { crossLanguage: false, ranks: { semantic: 3, lexical: null, hybrid: 2 } },
      { crossLanguage: true, ranks: { semantic: 1, lexical: null, hybrid: 1 } },
      { crossLanguage: true, ranks: { semantic: 8, lexical: null, hybrid: 7 } },
    ]);
    const cell = (channel: string, group: string) =>
      rows.find((row) => row.channel === channel && row.group === group);
    expect(cell('semantic', 'all')).toMatchObject({ questions: 4, hitAt1: 0.5, hitAt6: 0.75 });
    expect(cell('lexical', 'all')).toMatchObject({ hitAt1: 0.25, hitAt6: 0.25 });
    expect(cell('hybrid', 'same-language')).toMatchObject({ questions: 2, hitAt1: 0.5, hitAt6: 1 });
    expect(cell('lexical', 'cross-language')).toMatchObject({ questions: 2, hitAt1: 0, hitAt6: 0 });
    expect(retrievalBenchmark([]).every((row) => row.hitAt1 === null && row.hitAt6 === null)).toBe(true);
  });
});

describe('renderGenerated', () => {
  it('writes a TypeScript file that constants.ts can read, with the data behind every number in its header', () => {
    const text = renderGenerated(
      'some-model',
      768,
      computeThresholds([measure('unrelated', true, 0.5), measure('answerable', true, 0.8)]),
      '2026-10-02',
    );
    expect(text).toContain('GENERATED by `npm run calibrate`');
    expect(text).toContain("'some-model': {");
    expect(text).toMatch(/floor: \d\.\d+,/u);
    expect(text).toContain('crossLanguageStrong:');
    expect(text).toContain('informativeCoverage:');
    expect(text).toContain('highest unrelated question');
    expect(text).toContain("import type { EvidenceThresholds } from './constants.js';");
  });
});
