import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DocumentDetail } from '@enchanted/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../src/config.js';
import {
  computeThresholds,
  renderGenerated,
  retrievalBenchmark,
  type BenchmarkResult,
  type Channel,
  type Measure,
  type ProbeKind,
} from '../../src/rag/calibration.js';
import { isSameLanguage } from '../../src/rag/language.js';
import { normalizeQuery } from '../../src/rag/query.js';
import { retrieve, type RetrievalMode } from '../../src/rag/retrieve.js';
import type { Client } from '../http-helpers.js';
import { liveConfig, startLive, writeTaskData, type Live } from './live.js';

/*
 * `npm run calibrate`: the calibration of the evidence gate and the retrieval benchmark, for the embedding model in use
 * (reproducible: nothing here is edited by hand afterwards).
 *
 * No language model is called. The fixtures are ingested (their chunks embedded with Gemini) and the labelled questions below
 * are embedded in ONE batched request, then every one is run through the retrieval module (cached embeddings: no further
 * requests). Two things come out of it:
 *  1. the thresholds of the evidence gate (src/rag/calibration.ts computes them from what the gate reads: the best cosine, the
 *     shared words and how much of the question they cover, whether the question is in the document's own language), written
 *     with `CALIBRATE_WRITE=1` to src/rag/calibration.generated.ts, which constants.ts reads;
 *  2. the retrieval benchmark (review M30 and ruling 7): hit@1 and hit@6 of the semantic, the lexical and the hybrid channel,
 *     over the answerable questions, same language and across languages (the cross-lingual check).
 * Both go to .data/task4/calibration.json with the margins on each side of every threshold.
 *
 * Questions are labelled by hand: `answerable` (the document says it; `answer` is a phrase of the chunk that does),
 * `unrelated` (nothing in the document is about it) and `trap` (in the document's topic, but not answered: a football ranking in
 * a university brochure; no threshold separates these from the answerable ones, the grounding check and the model do).
 *
 * Requests to Gemini: one batch of chunks per document (3) + one batch of questions = about 4, no generation.
 */

const config = liveConfig();
const calibrate = process.env.RUN_CALIBRATION === '1';
const write = process.env.CALIBRATE_WRITE === '1';
/** What a run may ask of Gemini (the ingestion of 3 documents and the batch of questions need about 4). */
const MAX_REQUESTS = 12;

type DocKey = 'tips' | 'text-en' | 'arabic';

interface Probe {
  doc: DocKey;
  kind: ProbeKind;
  question: string;
  /** For answerable questions: a phrase of the chunk that holds the answer (the benchmark's ground truth). */
  answer?: string;
}

const PROBES: Probe[] = [
  // --- Lab 2's document (English): its four questions and the controller's extra probes, in both languages ---
  {
    doc: 'tips',
    kind: 'answerable',
    question: 'Where is Tips Hindawi University located?',
    answer: 'located in the heart of the Middle',
  },
  {
    doc: 'tips',
    kind: 'answerable',
    question: 'أين تقع جامعة تيبس هنداوي؟',
    answer: 'located in the heart of the Middle',
  },
  {
    doc: 'tips',
    kind: 'answerable',
    question: 'Is there financial aid for international students?',
    answer: 'Merit Scholarships',
  },
  {
    doc: 'tips',
    kind: 'answerable',
    question: 'هل يوجد دعم مالي للطلاب الدوليين؟',
    answer: 'Merit Scholarships',
  },
  {
    doc: 'tips',
    kind: 'answerable',
    question: 'Who is the president of the university?',
    answer: 'President: Dr. Nabil',
  },
  { doc: 'tips', kind: 'answerable', question: 'من هو رئيس الجامعة؟', answer: 'President: Dr. Nabil' },
  {
    doc: 'tips',
    kind: 'answerable',
    question: 'How much is undergraduate tuition?',
    answer: 'Undergraduate: $5,000',
  },
  {
    doc: 'tips',
    kind: 'answerable',
    question: 'كم تبلغ الرسوم الدراسية للمرحلة الجامعية؟',
    answer: 'Undergraduate: $5,000',
  },
  {
    doc: 'tips',
    kind: 'answerable',
    question: 'What faculties does the university have?',
    answer: 'Faculty of Engineering',
  },
  {
    doc: 'tips',
    kind: 'answerable',
    question: 'ما هي الكليات الموجودة في الجامعة؟',
    answer: 'Faculty of Engineering',
  },
  { doc: 'tips', kind: 'trap', question: 'Does the university offer online programs?' },
  { doc: 'tips', kind: 'trap', question: 'هل تقدم الجامعة برامج دراسية عبر الإنترنت؟' },
  { doc: 'tips', kind: 'trap', question: 'What languages are used for instruction?' },
  { doc: 'tips', kind: 'trap', question: 'ما هي لغات التدريس في الجامعة؟' },
  { doc: 'tips', kind: 'trap', question: "What is the university's football team ranking?" },
  { doc: 'tips', kind: 'trap', question: 'ما هو ترتيب فريق كرة القدم في الجامعة؟' },
  { doc: 'tips', kind: 'unrelated', question: 'What is the capital of Peru?' },
  { doc: 'tips', kind: 'unrelated', question: 'ما عاصمة بيرو؟' },
  { doc: 'tips', kind: 'unrelated', question: 'How do I bake sourdough bread at home?' },
  { doc: 'tips', kind: 'unrelated', question: 'كيف أخبز الخبز في المنزل؟' },
  // not about the brochure, but a capitalised word of each ("President", "Arabic") is one the brochure capitalises too: to the gate it
  // is a proper name that the document has, so the question passes WITHOUT the cosine test (review NB-10). The calibration counts
  // such questions in its `exempt` figures (the leak counts of the floors do not see them), so that how often it happens is measured
  { doc: 'tips', kind: 'unrelated', question: 'Who is the President of France?' },
  { doc: 'tips', kind: 'unrelated', question: 'Which Arabic restaurant in Paris is the best?' },
  // paraphrases that share no word with the passage that answers them: the gate's worst case (it only reads the cosine when no
  // informative word matches), so these are what the same-language floor must let through
  { doc: 'tips', kind: 'answerable', question: 'Who heads the place?', answer: 'President: Dr. Nabil' },
  {
    doc: 'tips',
    kind: 'answerable',
    question: 'What do bachelor students pay yearly?',
    answer: 'Undergraduate: $5,000',
  },
  { doc: 'tips', kind: 'answerable', question: 'Where do freshmen sleep?', answer: 'Al-Nour Dormitory' },
  {
    doc: 'tips',
    kind: 'answerable',
    question: 'Which lab studies sun-powered water purification?',
    answer: 'Solar-Powered Desalination',
  },
  {
    doc: 'tips',
    kind: 'answerable',
    question: 'Which clubs can a student join?',
    answer: 'THU Debate Society',
  },
  { doc: 'tips', kind: 'answerable', question: 'ما هي النوادي الطلابية؟', answer: 'THU Debate Society' },
  // --- the English fixture (Thornquist House) ---
  {
    doc: 'text-en',
    kind: 'answerable',
    question: 'Who founded Thornquist House?',
    answer: 'founded by Alaric Thornquist',
  },
  {
    doc: 'text-en',
    kind: 'answerable',
    question: 'Who was Alaric Thornquist?',
    answer: 'founded by Alaric Thornquist',
  },
  {
    doc: 'text-en',
    kind: 'answerable',
    question: 'What is MS-4471?',
    answer: 'labelled with the identifier MS-4471',
  },
  {
    doc: 'text-en',
    kind: 'answerable',
    question: 'Who established the estate?',
    answer: 'founded by Alaric Thornquist',
  },
  {
    doc: 'text-en',
    kind: 'answerable',
    question: 'Which hygiene rule applies before handling a volume?',
    answer: 'Wash your hands',
  },
  {
    doc: 'text-en',
    kind: 'answerable',
    question: 'من أسس بيت ثورنكويست؟',
    answer: 'founded by Alaric Thornquist',
  },
  {
    doc: 'text-en',
    kind: 'answerable',
    question: 'ما هو المعرّف MS-4471؟',
    answer: 'labelled with the identifier MS-4471',
  },
  { doc: 'text-en', kind: 'unrelated', question: 'What is the capital of Peru?' },
  { doc: 'text-en', kind: 'unrelated', question: 'ما عاصمة بيرو؟' },
  { doc: 'text-en', kind: 'unrelated', question: 'How do I bake sourdough bread at home?' },
  // --- the Arabic fixture (a library) ---
  { doc: 'arabic', kind: 'answerable', question: 'من أسس المكتبة؟', answer: 'أسس المكتبة الرحالة' },
  { doc: 'arabic', kind: 'answerable', question: 'Who founded the library?', answer: 'أسس المكتبة الرحالة' },
  {
    doc: 'arabic',
    kind: 'answerable',
    question: 'متى أعيد فتح المكان للجمهور؟',
    answer: 'أعيد افتتاح المكتبة',
  },
  {
    doc: 'arabic',
    kind: 'answerable',
    question: 'When was the library reopened to the public?',
    answer: 'أعيد افتتاح المكتبة',
  },
  { doc: 'arabic', kind: 'answerable', question: 'ماذا جرى للصندوق الصغير؟', answer: 'صندوقا صغيرا' },
  {
    doc: 'arabic',
    kind: 'answerable',
    question: 'What happened to the small box?',
    answer: 'صندوقا صغيرا',
  },
  { doc: 'arabic', kind: 'unrelated', question: 'ما عاصمة بيرو؟' },
  { doc: 'arabic', kind: 'unrelated', question: 'كيف أطبخ الأرز؟' },
  { doc: 'arabic', kind: 'unrelated', question: 'What is the capital of Peru?' },
  { doc: 'arabic', kind: 'unrelated', question: 'How do I bake sourdough bread at home?' },
  // more unrelated topics (the gate's floors are set by the highest of them: three topics were too few to trust a margin)
  ...(
    [
      ['Who won the 2018 football World Cup?', 'من فاز بكأس العالم لكرة القدم؟'],
      ['What is the boiling point of water at sea level?', 'ما درجة غليان الماء عند مستوى سطح البحر؟'],
      ['How do I install Python on Windows?', 'كيف أثبت لغة بايثون على ويندوز؟'],
      ['What is the stock price of Apple today?', 'ما سعر سهم أبل اليوم؟'],
      ['Who painted the Mona Lisa?', 'من رسم الموناليزا؟'],
      ['What are good exercises for back pain?', 'ما أفضل تمارين آلام الظهر؟'],
      ['Explain quantum entanglement in simple terms.', 'اشرح التشابك الكمي ببساطة.'],
    ] as const
  ).flatMap(([english, arabicQuestion]): Probe[] => [
    { doc: 'tips', kind: 'unrelated', question: english },
    { doc: 'tips', kind: 'unrelated', question: arabicQuestion },
    { doc: 'text-en', kind: 'unrelated', question: english },
    { doc: 'text-en', kind: 'unrelated', question: arabicQuestion },
    { doc: 'arabic', kind: 'unrelated', question: english },
    { doc: 'arabic', kind: 'unrelated', question: arabicQuestion },
  ]),
];

interface Observation extends Measure {
  doc: DocKey;
  question: string;
  documentLanguage: string;
  /** Rank of the answer per channel (answerable questions only). */
  ranks: Record<Channel, number | null> | null;
}

const observations: Observation[] = [];
let live: Live;
const documents = new Map<DocKey, { client: Client; document: DocumentDetail }>();

const round = (value: number | null): number | null =>
  value === null ? null : Math.round(value * 1000) / 1000;

describe.skipIf(config === null || !calibrate)(
  'gemini-embedding-2: evidence gate calibration and retrieval benchmark',
  () => {
    beforeAll(async () => {
      if (config === null) return;
      live = await startLive(config, MAX_REQUESTS);
      for (const [key, name] of [
        ['tips', 'tips-hindawi-university.pdf'],
        ['text-en', 'text-en.pdf'],
        ['arabic', 'arabic.pdf'],
      ] as const) {
        documents.set(key, await live.ingest(name));
      }
      // every question embedded in ONE request: the retrievals below are served from memory
      await live.embeddings.prime(PROBES.map((probe) => normalizeQuery(probe.question)));
    }, 600_000);

    afterAll(async () => {
      if (config !== null) await live.close();
    }, 120_000);

    it('measures every labelled question, computes the thresholds and the benchmark, and records them', async () => {
      if (config === null) return;
      const search = async (probe: Probe, mode: RetrievalMode, entry: { document: DocumentDetail }) =>
        retrieve(
          { db: live.db, embeddings: live.embeddings },
          {
            documentId: entry.document.id,
            query: probe.question,
            topK: 6,
            candidates: live.config.ragCandidates,
            // no character budget in the benchmark: the six best chunks are the six best chunks
            contextCharBudget: 1_000_000,
            pageCount: entry.document.pageCount,
            mode,
          },
        );

      for (const probe of PROBES) {
        const entry = documents.get(probe.doc);
        if (entry === undefined) throw new Error(`${probe.doc} was not ingested`);
        const hybrid = await search(probe, 'hybrid', entry);
        expect(hybrid.signals.hasChunks).toBe(true);
        let ranks: Observation['ranks'] = null;
        if (probe.kind === 'answerable') {
          if (probe.answer === undefined) throw new Error(`no answer phrase for: ${probe.question}`);
          const rankOf = (outcome: Awaited<ReturnType<typeof search>>): number | null => {
            const index = outcome.chunks.findIndex((retrieved) =>
              retrieved.chunk.content.includes(probe.answer ?? ''),
            );
            return index < 0 ? null : index + 1;
          };
          const semantic = await search(probe, 'semantic', entry);
          const lexical = await search(probe, 'lexical', entry);
          ranks = { semantic: rankOf(semantic), lexical: rankOf(lexical), hybrid: rankOf(hybrid) };
          // the phrase must exist: a typo here would read as a retrieval failure
          const present = await live.db.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM document_chunks WHERE document_id = $1 AND position($2 in content) > 0',
            [entry.document.id, probe.answer],
          );
          expect(
            present.rows[0]?.n,
            `the answer phrase of "${probe.question}" is in the document`,
          ).toBeGreaterThan(0);
        }
        observations.push({
          doc: probe.doc,
          kind: probe.kind,
          question: probe.question,
          documentLanguage: entry.document.primaryLanguage,
          sameLanguage: isSameLanguage(probe.question, entry.document.primaryLanguage),
          topCosine: hybrid.signals.topCosine,
          lexicalHit: hybrid.signals.lexicalHit,
          lexicalCoverage: hybrid.signals.lexicalCoverage,
          identifierHit: hybrid.signals.identifierHit,
          properNameHit: hybrid.signals.properNameHit,
          ranks,
        });
      }

      const report = computeThresholds(observations);
      const benchmarkInput: BenchmarkResult[] = observations.flatMap((observation) =>
        observation.ranks === null
          ? []
          : [{ ranks: observation.ranks, crossLanguage: observation.sameLanguage === false }],
      );
      const benchmark = retrievalBenchmark(benchmarkInput);
      const stamp = new Date().toISOString().slice(0, 10);
      const summary = {
        model: live.embeddings.model,
        dimensions: live.config.embeddingDimensions,
        calibratedOn: stamp,
        requests: { ...live.budget.counts, total: live.budget.total },
        report,
        benchmark,
        observations: observations.map((observation) => ({
          ...observation,
          topCosine: round(observation.topCosine),
          lexicalCoverage: round(observation.lexicalCoverage),
        })),
      };
      await writeTaskData('calibration.json', JSON.stringify(summary, null, 2));
      // a calibration whose own checks fail (an answerable question stopped, a floor too close to one) is never written
      if (write && report.checks.ok) {
        await writeFile(
          path.join(REPO_ROOT, 'apps', 'server', 'src', 'rag', 'calibration.generated.ts'),
          renderGenerated(live.embeddings.model, live.config.embeddingDimensions, report, stamp),
        );
      }

      const lines = observations.map(
        (observation) =>
          `${observation.kind.padEnd(10)} ${observation.sameLanguage === null ? 'lang?' : observation.sameLanguage ? 'same ' : 'cross'} lexical=${observation.lexicalHit ? 'yes' : 'no '} cov=${String(round(observation.lexicalCoverage)).padEnd(5)} cos=${String(round(observation.topCosine)).padEnd(6)} ${observation.doc.padEnd(8)} ${observation.question}${observation.ranks === null ? '' : `   rank s/l/h = ${observation.ranks.semantic ?? '-'}/${observation.ranks.lexical ?? '-'}/${observation.ranks.hybrid ?? '-'}`}`,
      );
      const table = benchmark.map(
        (row) =>
          `${row.group.padEnd(14)} ${row.channel.padEnd(9)} n=${String(row.questions).padEnd(3)} hit@1=${String(row.hitAt1)} hit@6=${String(row.hitAt6)}`,
      );
      console.info(
        `\ncalibration of ${live.embeddings.model} (${write && report.checks.ok ? 'written to calibration.generated.ts' : 'not written: CALIBRATE_WRITE=1 writes it, and only a calibration that passes its checks'})\n${lines.join('\n')}\n\n${JSON.stringify(report, null, 2)}\n\nretrieval benchmark\n${table.join('\n')}\nGemini requests: ${JSON.stringify({ ...live.budget.counts, total: live.budget.total })}\n`,
      );

      // what a run must not silently produce: a gate that stops what it should let through, a hybrid channel that loses answers
      expect(report.checks.problems, 'the calibration checks').toEqual([]);
      expect(report.thresholds.floor).toBeGreaterThanOrEqual(0.3);
      expect(report.thresholds.sameLanguageFloor).toBeGreaterThanOrEqual(0.3);
      const hybridAll = benchmark.find((row) => row.channel === 'hybrid' && row.group === 'all');
      expect(hybridAll?.hitAt6 ?? 0).toBeGreaterThanOrEqual(0.8);
      expect(live.budget.total).toBeLessThanOrEqual(MAX_REQUESTS);
    }, 300_000);
  },
);
