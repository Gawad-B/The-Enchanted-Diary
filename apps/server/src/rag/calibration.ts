import type { EvidenceThresholds } from './constants.js';

/*
 * The arithmetic of `npm run calibrate` (test/evals/rag-calibration.eval.test.ts measures, this file decides). Every labelled
 * question is run through retrieval with the live embedding model and what the evidence gate reads is recorded: the best
 * cosine, the shared words and how much of the question they cover, whether the question is in the document's language. From
 * those measures this file computes the thresholds of `EvidenceThresholds`, the retrieval benchmark (M30: hit@1 and hit@6 per
 * channel), and the file `rag/calibration.generated.ts` that constants.ts reads. Pure functions: tested without a model.
 *
 * What a question is, for the thresholds:
 *  - `answerable`: the document says it. The gate must NEVER stop one (a question it wrongly stops is lost for good);
 *  - `unrelated`: nothing in the document is about it (the capital of Peru, baking bread). The gate should stop these without
 *    a model call;
 *  - `trap`: in-topic but not answered (a football ranking in a university's brochure). No threshold separates these from the
 *    answerable ones, and none should try: the grounding check and the model's own refusal are their guards. They only keep the
 *    "strong" marks honest (a trap must not read as strong evidence).
 */

export type ProbeKind = 'answerable' | 'unrelated' | 'trap';

export interface Measure {
  kind: ProbeKind;
  /** The question itself, for the report's list of what the gate lets through on a shared word (optional: the arithmetic needs only the numbers). */
  question?: string;
  /** The document the question was asked of (for the leave-one-document-out check). */
  doc?: string;
  /** Written in the document's own language (true), another (false); null when either is not known. */
  sameLanguage: boolean | null;
  topCosine: number | null;
  lexicalHit: boolean;
  lexicalCoverage: number;
  identifierHit: boolean;
  properNameHit: boolean;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const max = (values: readonly number[]): number | null => (values.length === 0 ? null : Math.max(...values));
const min = (values: readonly number[]): number | null => (values.length === 0 ? null : Math.min(...values));

/** The value at fraction `q` (0..1) of the sorted values, linear between neighbours. */
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] ?? 0;
  const high = sorted[upper] ?? low;
  return low + (high - low) * (position - lower);
}

export interface GateMargins {
  /** The highest cosine of an unrelated question the gate sees (no informative word) in this group, and the lowest of an answerable one. */
  unrelatedMax: number | null;
  answerableMin: number | null;
  /** How far the floor is above the unrelated ones and below the answerable ones (null when a side has no data). */
  aboveUnrelated: number | null;
  belowAnswerable: number | null;
  separable: boolean | null;
  exposedUnrelated: number;
  exposedAnswerable: number;
  /** Unrelated questions the floor lets through to guards 2 and 3 (they cost a model call, nothing more). */
  leaks: number;
  /** Answerable questions the floor would stop (lost for good): must be 0. */
  losses: number;
}

export interface CalibrationReport {
  thresholds: EvidenceThresholds;
  sameLanguage: GateMargins;
  crossLanguage: GateMargins;
  coverage: {
    /** Highest coverage of an unrelated or trap question whose only shared words are generic, lowest of an answerable one. */
    genericMax: number | null;
    answerableMin: number | null;
    /** The generic shared words of the unrelated questions cover less than those of the answerable ones (null: no data). */
    separable: boolean | null;
    /** What the gate does with the labelled questions at the chosen coverage: unrelated ones it stops, answerable ones it would stop. */
    stopped: number;
    lost: number;
  };
  strong: {
    sameLanguage: { trapMax: number | null; answerableQ25: number | null };
    crossLanguage: { trapMax: number | null; answerableQ25: number | null };
  };
  /**
   * The questions the gate lets through WITHOUT the cosine test, because a word they share with the document counts as evidence
   * (the floors never see them; the grounding check and the model's own refusal are what stand behind them), by the kind of word:
   * a proper name (a capitalised word of the question that the document capitalises too: "President" and "Arabic" are names to it,
   * whatever they are in the document's headings), an identifier, or generic words that cover enough of the question. The leak counts
   * of the floors above do not include them. `unrelated` is the number that matters (a question that is not about the document at
   * all); `questions` lists those.
   */
  exempt: {
    unrelated: { name: number; identifier: number; sharedWords: number };
    trap: { name: number; identifier: number; sharedWords: number };
    questions: string[];
  };
  samples: { answerable: number; unrelated: number; trap: number };
  /** What `npm run calibrate` refuses to ship: an answerable question lost, or a floor closer to one than MIN_ANSWERABLE_MARGIN. */
  checks: { ok: boolean; problems: string[] };
  /**
   * How the floors would have done on questions they had not seen: each answerable question left out in turn (and each document),
   * the floors recomputed from the rest, and the questions the new floors would stop. Informational: a question below every one
   * the calibration has seen can always be lost, and these lists say how close that is.
   */
  robustness: { leaveOneOut: string[]; leaveOneDocumentOut: string[] };
  notes: string[];
}

const hasInformativeWord = (m: Measure, coverageThreshold: number): boolean =>
  m.lexicalHit && (m.identifierHit || m.properNameHit || m.lexicalCoverage >= coverageThreshold);

/** The coverages tried for the shared-word threshold. */
const COVERAGE_GRID = Array.from({ length: 9 }, (_, index) => round2(0.3 + index * 0.05));

/**
 * The shared-word threshold: a generic shared word ("capital", "home") is not evidence, so it must not switch off guard 1. For
 * every candidate coverage the two floors are computed (they depend on which questions the gate sees at all) and the candidate
 * is judged on what the gate then does with the labelled questions, in this order:
 *  1. answerable questions it would stop (none: a question wrongly stopped is lost for good);
 *  2. unrelated questions a generic shared word keeps past the gate (none, where it can be: ruling 3, "the capital of Peru" asked of a
 *     brochure that says "the capital city" is not covered because they share "capital"; whether the floor then stops it is the
 *     cosine's business);
 *  3. unrelated questions it stops (as many as possible);
 *  4. the narrowest gap between the highest unrelated and the lowest answerable cosine the floors have to fit between;
 *  5. the lowest coverage (the more lenient: more shared words count as evidence).
 */
function coverageThreshold(
  measures: readonly Measure[],
  notes: string[],
): { value: number; report: CalibrationReport['coverage'] } {
  const generic = (m: Measure): boolean => m.lexicalHit && !m.identifierHit && !m.properNameHit;
  const against = measures.filter((m) => m.kind !== 'answerable' && generic(m)).map((m) => m.lexicalCoverage);
  const answerable = measures
    .filter((m) => m.kind === 'answerable' && generic(m))
    .map((m) => m.lexicalCoverage);
  const genericMax = max(against);
  const answerableMin = min(answerable);
  const sameGroup = measures.filter((m) => m.sameLanguage === true);
  const crossGroup = measures.filter((m) => m.sameLanguage === false);
  if (genericMax === null && answerableMin === null) {
    notes.push('no question with a generic shared word: the coverage threshold is the default 0.5');
    return { value: 0.5, report: { genericMax, answerableMin, separable: null, stopped: 0, lost: 0 } };
  }
  const judge = (coverage: number) => {
    const scratch: string[] = [];
    const same = floorFor(sameGroup, coverage, '', scratch);
    const cross = floorFor(crossGroup, coverage, '', scratch);
    let lost = 0;
    let stopped = 0;
    for (const [group, floor] of [
      [sameGroup, same.floor],
      [crossGroup, cross.floor],
    ] as const) {
      for (const m of group) {
        if (m.topCosine === null || hasInformativeWord(m, coverage) || m.topCosine >= floor) continue;
        if (m.kind === 'answerable') lost += 1;
        else if (m.kind === 'unrelated') stopped += 1;
      }
    }
    const gaps = [same.margins, cross.margins].flatMap((margins) =>
      margins.unrelatedMax === null || margins.answerableMin === null
        ? []
        : [margins.answerableMin - margins.unrelatedMax],
    );
    // unrelated questions kept past the gate by a generic shared word (not a name, not an identifier)
    const exempt = measures.filter(
      (m) => m.kind === 'unrelated' && generic(m) && hasInformativeWord(m, coverage),
    ).length;
    return { coverage, lost, exempt, stopped, gap: gaps.length === 0 ? Infinity : Math.min(...gaps) };
  };
  const best = COVERAGE_GRID.map(judge).sort(
    (a, b) =>
      a.lost - b.lost ||
      a.exempt - b.exempt ||
      b.stopped - a.stopped ||
      b.gap - a.gap ||
      a.coverage - b.coverage,
  )[0];
  const chosen = best ?? judge(0.5);
  if (chosen.lost > 0) {
    notes.push(
      `${String(chosen.lost)} answerable question(s) would be stopped whatever the shared-word coverage: see the floors' margins`,
    );
  }
  return {
    value: chosen.coverage,
    report: {
      genericMax,
      answerableMin,
      separable: genericMax !== null && answerableMin !== null ? genericMax < answerableMin : null,
      stopped: chosen.stopped,
      lost: chosen.lost,
    },
  };
}

/** The floor sits this far above the highest unrelated question the gate sees... */
const UNRELATED_MARGIN = 0.03;
/** ...and never closer than this to the lowest answerable one (the margin `npm run calibrate` insists on). */
export const MIN_ANSWERABLE_MARGIN = 0.03;

/**
 * The floor of one language group. A question the floor stops is lost for good (no model is asked), one it lets through still
 * meets the grounding check and the model's own refusal: so the two mistakes are not the same size. The floor goes just above
 * the highest unrelated question (UNRELATED_MARGIN), but never closer than MIN_ANSWERABLE_MARGIN to the lowest answerable one:
 * when the two are closer than that, unrelated questions leak through to guards 2 and 3 and the floor stays clear of the
 * answerable one. Floors are rounded DOWN, so that the margin holds after rounding.
 */
function floorFor(
  group: readonly Measure[],
  coverage: number,
  label: string,
  notes: string[],
): { floor: number; margins: GateMargins } {
  const exposed = group.filter((m) => m.topCosine !== null && !hasInformativeWord(m, coverage));
  const unrelated = exposed.filter((m) => m.kind === 'unrelated').map((m) => m.topCosine ?? 0);
  const answerable = exposed.filter((m) => m.kind === 'answerable').map((m) => m.topCosine ?? 0);
  const unrelatedMax = max(unrelated);
  const answerableMin = min(answerable);
  let floor: number;
  let separable: boolean | null = null;
  if (unrelatedMax === null && answerableMin === null) {
    floor = 0.6;
    notes.push(`${label}: no question reaches the cosine test: the floor is the default 0.6`);
  } else if (unrelatedMax === null) {
    floor = (answerableMin ?? 0.65) - 0.05;
    notes.push(
      `${label}: no unrelated question reaches the cosine test: the floor sits 0.05 under the lowest answerable one`,
    );
  } else if (answerableMin === null) {
    floor = unrelatedMax + UNRELATED_MARGIN;
    notes.push(
      `${label}: no answerable question reaches the cosine test: the floor sits 0.03 over the highest unrelated one`,
    );
  } else {
    separable = unrelatedMax < answerableMin;
    floor = Math.min(unrelatedMax + UNRELATED_MARGIN, answerableMin - MIN_ANSWERABLE_MARGIN);
    if (floor <= unrelatedMax) {
      notes.push(
        `${label}: the highest unrelated question (${String(round2(unrelatedMax))}) is within ${String(MIN_ANSWERABLE_MARGIN)} of the lowest answerable one (${String(round2(answerableMin))}): the floor stays clear of the answerable one, and unrelated questions leak to guards 2 and 3`,
      );
    }
  }
  const value = Math.floor(clamp(floor, 0.3, 0.9) * 100 + 1e-9) / 100;
  return {
    floor: value,
    margins: {
      unrelatedMax,
      answerableMin,
      aboveUnrelated: unrelatedMax === null ? null : round2(value - unrelatedMax),
      belowAnswerable: answerableMin === null ? null : round2(answerableMin - value),
      separable,
      exposedUnrelated: unrelated.length,
      exposedAnswerable: answerable.length,
      leaks: unrelated.filter((cosine) => cosine >= value).length,
      losses: answerable.filter((cosine) => cosine < value).length,
    },
  };
}

/**
 * The strong mark of a group: just above the highest trap question (an in-topic question the document does not answer must
 * never read as strong evidence), and no higher. The mark is what tells the answer model how much to trust the excerpts, and a
 * model told "weak" over-refuses (a live probe: the same excerpts and question were refused every time under the weak note and
 * answered under the strong one; the weak note has since been reworded as a call for strictness), so the mark is the LOWEST that keeps the traps weak: as many answerable questions as possible
 * read as strong. Without traps in the group it falls back to the lower quartile of the answerable ones, else to the floor + 0.1.
 */
function strongFor(
  group: readonly Measure[],
  floor: number,
): { mark: number; trapMax: number | null; q25: number | null } {
  const traps = group.filter((m) => m.kind === 'trap' && m.topCosine !== null).map((m) => m.topCosine ?? 0);
  const answerable = group
    .filter((m) => m.kind === 'answerable' && m.topCosine !== null)
    .map((m) => m.topCosine ?? 0);
  const trapMax = max(traps);
  const q25 = quantile(answerable, 0.25);
  const mark = trapMax !== null ? trapMax + 0.02 : (q25 ?? floor + 0.1);
  return { mark: round2(Math.max(mark, floor + 0.02)), trapMax, q25 };
}

/** What exempts a question from the cosine test, the strongest first: an identifier, a name, else shared words. */
const exemptionOf = (m: Measure): 'identifier' | 'name' | 'sharedWords' =>
  m.identifierHit ? 'identifier' : m.properNameHit ? 'name' : 'sharedWords';

function exemptions(measures: readonly Measure[], coverage: number): CalibrationReport['exempt'] {
  const count = (): { name: number; identifier: number; sharedWords: number } => ({
    name: 0,
    identifier: 0,
    sharedWords: 0,
  });
  const report: CalibrationReport['exempt'] = { unrelated: count(), trap: count(), questions: [] };
  for (const m of measures) {
    if (m.kind === 'answerable' || !hasInformativeWord(m, coverage)) continue;
    const kind = exemptionOf(m);
    report[m.kind][kind] += 1;
    if (m.kind === 'unrelated') {
      report.questions.push(`${m.doc ?? '?'}: ${m.question ?? '(question not recorded)'} [${kind}]`);
    }
  }
  return report;
}

/** The thresholds of one embedding model from the measures of the labelled questions. */
export function computeThresholds(measures: readonly Measure[]): CalibrationReport {
  const notes: string[] = [];
  const coverage = coverageThreshold(measures, notes);
  // "Same language" and "unknown" are measured with the same-language group's questions: an unknown language takes the lower floor at run time.
  const sameGroup = measures.filter((m) => m.sameLanguage === true);
  const crossGroup = measures.filter((m) => m.sameLanguage === false);
  const same = floorFor(sameGroup, coverage.value, 'same language', notes);
  const cross = floorFor(crossGroup, coverage.value, 'across languages', notes);
  const sameStrong = strongFor(sameGroup, same.floor);
  const crossStrong = strongFor(crossGroup, cross.floor);
  const problems: string[] = [];
  for (const [label, margins] of [
    ['same language', same.margins],
    ['across languages', cross.margins],
  ] as const) {
    if (margins.losses > 0) {
      problems.push(`${label}: the floor would stop ${String(margins.losses)} answerable question(s)`);
    }
    if (margins.belowAnswerable !== null && margins.belowAnswerable < MIN_ANSWERABLE_MARGIN - 1e-9) {
      problems.push(
        `${label}: the floor is only ${String(margins.belowAnswerable)} below the lowest answerable question (at least ${String(MIN_ANSWERABLE_MARGIN)} is required)`,
      );
    }
  }
  return {
    thresholds: {
      floor: cross.floor,
      sameLanguageFloor: same.floor,
      strong: sameStrong.mark,
      crossLanguageStrong: crossStrong.mark,
      informativeCoverage: coverage.value,
    },
    sameLanguage: same.margins,
    crossLanguage: cross.margins,
    coverage: coverage.report,
    strong: {
      sameLanguage: { trapMax: sameStrong.trapMax, answerableQ25: sameStrong.q25 },
      crossLanguage: { trapMax: crossStrong.trapMax, answerableQ25: crossStrong.q25 },
    },
    exempt: exemptions(measures, coverage.value),
    samples: {
      answerable: measures.filter((m) => m.kind === 'answerable').length,
      unrelated: measures.filter((m) => m.kind === 'unrelated').length,
      trap: measures.filter((m) => m.kind === 'trap').length,
    },
    checks: { ok: problems.length === 0, problems },
    robustness: {
      leaveOneOut: leaveOutLosses(measures, coverage.value, (m, index) => String(index)),
      leaveOneDocumentOut: leaveOutLosses(measures, coverage.value, (m) => m.doc),
    },
    notes,
  };
}

/**
 * The answerable questions the floors would stop if the questions of `groupOf(question)` had not been among the measures (one
 * question at a time, or one document at a time): the floors are recomputed without them and the held-out answerable questions
 * judged against the new floors. Returns "question group: cosine < floor" lines.
 */
function leaveOutLosses(
  measures: readonly Measure[],
  coverage: number,
  groupOf: (measure: Measure, index: number) => string | undefined,
): string[] {
  const groups = new Map<string, number[]>();
  measures.forEach((measure, index) => {
    const key = groupOf(measure, index);
    if (key === undefined) return;
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  const lost: string[] = [];
  for (const [key, indexes] of groups) {
    const held = new Set(indexes);
    const rest = measures.filter((_, index) => !held.has(index));
    const scratch: string[] = [];
    const floors = {
      same: floorFor(
        rest.filter((m) => m.sameLanguage === true),
        coverage,
        '',
        scratch,
      ).floor,
      cross: floorFor(
        rest.filter((m) => m.sameLanguage === false),
        coverage,
        '',
        scratch,
      ).floor,
    };
    for (const index of indexes) {
      const m = measures[index];
      if (m?.kind !== 'answerable' || m.topCosine === null || m.sameLanguage === null) continue;
      if (hasInformativeWord(m, coverage)) continue;
      const floor = m.sameLanguage ? floors.same : floors.cross;
      if (m.topCosine < floor) {
        lost.push(
          `${m.doc ?? key}: an answerable question at ${String(round2(m.topCosine))} < floor ${String(floor)}`,
        );
      }
    }
  }
  return lost;
}

// --- the retrieval benchmark (M30) -----------------------------------------------------------------------------------

export type Channel = 'semantic' | 'lexical' | 'hybrid';

export interface BenchmarkResult {
  /** The 1-based rank of the first chunk that holds the answer, per channel; null when it is not in the top results. */
  ranks: Record<Channel, number | null>;
  /** The question is asked in another language than the document's (the cross-lingual check). */
  crossLanguage: boolean;
}

export interface BenchmarkRow {
  channel: Channel;
  group: 'all' | 'same-language' | 'cross-language';
  questions: number;
  hitAt1: number | null;
  hitAt6: number | null;
}

/** hit@1 and hit@6 (the share of questions whose answer is the first, and within the first six, chunks) per channel and group. */
export function retrievalBenchmark(results: readonly BenchmarkResult[]): BenchmarkRow[] {
  const groups: Record<BenchmarkRow['group'], readonly BenchmarkResult[]> = {
    all: results,
    'same-language': results.filter((result) => !result.crossLanguage),
    'cross-language': results.filter((result) => result.crossLanguage),
  };
  const rows: BenchmarkRow[] = [];
  for (const [group, items] of Object.entries(groups) as [
    BenchmarkRow['group'],
    readonly BenchmarkResult[],
  ][]) {
    for (const channel of ['semantic', 'lexical', 'hybrid'] as const) {
      const share = (limit: number): number | null =>
        items.length === 0
          ? null
          : round2(items.filter((item) => (item.ranks[channel] ?? Infinity) <= limit).length / items.length);
      rows.push({ channel, group, questions: items.length, hitAt1: share(1), hitAt6: share(6) });
    }
  }
  return rows;
}

// --- the generated file ----------------------------------------------------------------------------------------------

const sumOf = (counts: { name: number; identifier: number; sharedWords: number }): number =>
  counts.name + counts.identifier + counts.sharedWords;

export function renderGenerated(
  model: string,
  dimensions: number,
  report: CalibrationReport,
  stamp: string,
  /** Said in the header when the numbers were recomputed from stored measures rather than measured: "recomputed offline on ...". */
  provenance = `on ${stamp}`,
): string {
  const t = report.thresholds;
  const side = (name: string, margins: GateMargins): string =>
    ` *   ${name}: highest unrelated question ${String(margins.unrelatedMax === null ? null : round2(margins.unrelatedMax))} ` +
    `(floor ${String(margins.aboveUnrelated)} above it), lowest answerable ${String(margins.answerableMin === null ? null : round2(margins.answerableMin))} ` +
    `(floor ${String(margins.belowAnswerable)} below it), ${String(margins.exposedUnrelated)} unrelated and ${String(margins.exposedAnswerable)} answerable questions reach the cosine test; ` +
    `${String(margins.leaks)} unrelated one(s) leak past the floor to guards 2 and 3, ${String(margins.losses)} answerable one(s) are stopped`;
  return `/*
 * GENERATED by \`npm run calibrate\` (test/evals/rag-calibration.eval.test.ts + rag/calibration.ts) ${provenance}.
 * Do not edit by hand: run the calibration again after changing the embedding model, its prefixes, the chunk sizes or the
 * documents it learns from. The data of the run is in .data/task4/calibration.json.
 *
 * ${model}, ${String(dimensions)} dimensions, ${String(report.samples.answerable)} answerable, ${String(report.samples.unrelated)} unrelated and ${String(report.samples.trap)} trap questions:
${side('same language', report.sameLanguage)}
${side('across languages', report.crossLanguage)}
 *   checks: ${report.checks.ok ? `ok (no answerable question stopped, every floor at least ${String(MIN_ANSWERABLE_MARGIN)} below the lowest answerable one)` : `FAILED: ${report.checks.problems.join('; ')}`}
 *   left out one question (document) at a time, the floors would stop ${String(report.robustness.leaveOneOut.length)} (${String(report.robustness.leaveOneDocumentOut.length)}) answerable question(s)
 *   shared words: generic ones cover up to ${String(report.coverage.genericMax === null ? null : round2(report.coverage.genericMax))} of a question that is not about the document, answerable questions
 *   with generic words cover down to ${String(report.coverage.answerableMin === null ? null : round2(report.coverage.answerableMin))}: a shared word is evidence from a coverage of ${String(t.informativeCoverage)}, the lowest that stops
 *   ${String(report.coverage.stopped)} unrelated question(s) at the floors while stopping ${String(report.coverage.lost)} answerable one(s)
 *   past the gate without the cosine test (a shared word counts as evidence): ${String(sumOf(report.exempt.unrelated))} unrelated question(s) (${String(report.exempt.unrelated.name)} on a name, ${String(report.exempt.unrelated.identifier)} on an identifier, ${String(report.exempt.unrelated.sharedWords)} on shared words) and ${String(sumOf(report.exempt.trap))} trap question(s); they are not in the leak counts above${report.exempt.questions.length === 0 ? '' : `: ${report.exempt.questions.join('; ')}`}
 *   strong marks: the highest trap question is ${String(report.strong.sameLanguage.trapMax === null ? null : round2(report.strong.sameLanguage.trapMax))} in the same language and ${String(report.strong.crossLanguage.trapMax === null ? null : round2(report.strong.crossLanguage.trapMax))} across languages (each mark is the lowest that keeps every trap weak)${report.notes.map((note) => `\n *   note: ${note}`).join('')}
 */
import type { EvidenceThresholds } from './constants.js';

export const CALIBRATED_THRESHOLDS: Readonly<Record<string, EvidenceThresholds>> = {
  '${model}': {
    floor: ${String(t.floor)},
    sameLanguageFloor: ${String(t.sameLanguageFloor)},
    strong: ${String(t.strong)},
    crossLanguageStrong: ${String(t.crossLanguageStrong)},
    informativeCoverage: ${String(t.informativeCoverage)},
  },
};
`;
}
