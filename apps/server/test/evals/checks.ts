/*
 * The checks of the live eval that are more than "answered or refused", kept apart from the live run so that they are tested like
 * any code: a check that accepts a wrong answer would let it count toward the pass rate that ruling 9 sets.
 *  - question 3 (Lab 2's "is there financial aid for international students?"), whose right answer is PARTIAL;
 *  - an Arabic reply has no English in it (global §T.2).
 */

import { FRAMING_PHRASES } from '../../src/rag/prompts.js';
import { splitSentences } from '../../src/rag/reply.js';
import { isSilenceStatement, questionContext } from '../../src/rag/silence.js';

// --- question 3: what a partial answer is -------------------------------------------------------------------------------
//
// The document lists scholarships, need-based grants and research fellowships and says nothing about international students.
// A partial answer says what it lists, names the missing qualifier AS A STATEMENT ABOUT THE DOCUMENT'S SILENCE ("the document does not
// state whether ..."), and does NOT invent an eligibility, or an ineligibility, the document never states. The silence is judged by
// production's own rule (silence.ts, with the question of the row): the checker never accepts a gap the answer could not keep.

/** The question of the eval rows (rag.eval.test.ts), the words a statement of the document's silence must be about. */
export const QUESTION_3 = {
  en: 'Is there financial aid for international students?',
  ar: 'هل يوجد دعم مالي للطلاب الدوليين؟',
} as const;

/**
 * The three kinds of aid the document lists, in English. "Need-based scholarships" is one kind (the need-based grants), not two.
 */
const AID_EN = [
  /(?<!need[-\s]?based\s)scholarships?/iu,
  /need[-\s]?based|financial need|\bneed\b/iu,
  /fellowships?/iu,
];
/**
 * The same, in Arabic: the scholarships ("المنح الدراسية", merit, excellence), the need-based grants ("منح الحاجة", the model also
 * writes "الاحتجاج" for "الاحتياج") and the research fellowships ("الزمالات"). "منح الحاجة" names the need-based grants ONLY: a
 * scholarship is named by "الدراسية" / "دراسية" or by merit, never by the bare word "منح" that every kind of grant carries.
 */
const AID_AR = [
  /(?:منح|منحة|منحا)\s+(?:ال)?دراسية|الجدارة|التفوق|الاستحقاق|المتفوقين/u,
  /(?:ال)?(?:حاجة|احتياج|احتجاج|محتاج)/u,
  /زمالات|زمالة/u,
];
/** Who the question is about, what is being offered, eligibility, and housing (a mention of international students that is not a claim). */
const INTERNATIONAL_EN = /(?:international|foreign|overseas)\s+students?/iu;
const INTERNATIONAL_AR = /الدوليين|الدوليون|الأجانب|الاجانب|الوافدين/u;
const AID_WORD_EN =
  /scholarship|grant|fellowship|financial|aid\b|funding|tuition\s+coverage|bursar|stipend|waiver|discount/iu;
const AID_WORD_AR = /منح|منحة|دعم|مساعد|زمالات|زمالة|مالي|المالية|تمويل|إعفاء|خصم/u;
const ELIGIBILITY_EN =
  /\b(?:eligib\w*|qualif\w*|apply|applies|receive\w*|entitled|exclud\w*|welcome|open\s+to|cannot|can't|can\s+not|may\s+not|not\s+allowed)\b/iu;
const ELIGIBILITY_AR = /يحق|مؤهل|يستحق|يمكنهم|يستطيعون|مستبعد|متاحة\s+ل|التقدم|الحصول/u;
const HOUSING_EN = /housing|dorm|residence|accommodation|apartment|campus\s+life/iu;
const HOUSING_AR = /سكن|السكني|السكنية|مساكن|إقامة|مجمع|مبيت|الإسكان/u;
/** A plural pronoun that, once international students have been named, can only be them. */
const PRONOUN_EN = /\b(?:they|them|their)\b/iu;
const PRONOUN_AR = /(?:^|\s)[وف]?(?:هم|لهم|يمكنهم|بإمكانهم|انهم|أنهم|إنهم|عليهم|فهم|منهم)(?=\s|$|[،,.])/u;

const MARKERS = /\[S\d{1,3}\]/gu;
const HAS_MARKER = /\[S\d{1,3}\]/u;

interface AnswerSentence {
  /** Without its markers. */
  text: string;
  cited: boolean;
}

/** The sentences of an answer, split as production splits them (reply.ts). */
const sentencesOfAnswer = (text: string): AnswerSentence[] =>
  text
    .split('\n')
    .flatMap((line) => splitSentences(line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/u, '')))
    .map((sentence) => ({
      text: sentence.replace(MARKERS, ' ').replace(/\s+/gu, ' ').trim(),
      cited: HAS_MARKER.test(sentence),
    }))
    .filter((sentence) => sentence.text !== '');

/** The clauses of a sentence (at , ; : —), each split again before a coordinated verb ("... [S1] and does not state ..."). */
const clausesOf = (sentence: string): string[] =>
  sentence
    .split(/[,;:،؛—]\s*/u)
    .map((clause) => clause.trim())
    .filter((clause) => clause !== '');
const subClausesOf = (clause: string, lang: 'en' | 'ar'): string[] =>
  clause
    .split(lang === 'en' ? /\s+(?=(?:and|but|yet)\s)/iu : /\s+(?=و?(?:لا|لم|لكن|ولكن|لكنها|لكنه)\s)/u)
    .map((part) => part.trim())
    .filter((part) => part !== '');

/**
 * What is wrong with an answer to question 3 (empty when it is a good partial answer). `citedPages` are the pages it cites.
 *  - at least 2 of the 3 kinds of aid the document lists, each by its own word;
 *  - the caveat is a statement about the DOCUMENT's silence on international students that production's rule accepts with the
 *    question (silence.ts): a whole sentence, a clause of a cited sentence, or a coordinated verb whose subject is the document
 *    ("The document lists X [S1] and does not state whether ..."). "whether international students can live on campus" is not
 *    about the question; "They are not given to international students" and "International students are not eligible" say
 *    something the document does not;
 *  - every sentence that cites nothing is such a statement as a WHOLE (production drops every other one: "..., but they likely
 *    are." is a claim);
 *  - nothing ties international students to aid or eligibility unless it is such a statement: not a clause after a comma or a
 *    semicolon, not an invented ineligibility, not a pronoun that stands for them after they were named ("..., but they can
 *    receive grants"); a clause about housing is exempt only when it names no aid;
 *  - page 2 cited.
 */
export function partialAnswerFailures(
  lang: 'en' | 'ar',
  text: string,
  citedPages: readonly number[],
  question: string = QUESTION_3[lang],
): string[] {
  const context = questionContext(question);
  const kinds = (lang === 'en' ? AID_EN : AID_AR).filter((pattern) => pattern.test(text)).length;
  const international = lang === 'en' ? INTERNATIONAL_EN : INTERNATIONAL_AR;
  const aidWord = lang === 'en' ? AID_WORD_EN : AID_WORD_AR;
  const eligibility = lang === 'en' ? ELIGIBILITY_EN : ELIGIBILITY_AR;
  const housing = lang === 'en' ? HOUSING_EN : HOUSING_AR;
  const pronoun = lang === 'en' ? PRONOUN_EN : PRONOUN_AR;
  // a coordinated verb has the document as its subject: put it back ("and does not state ..." -> "The document does not state ...")
  const silent = (part: string): boolean => {
    if (isSilenceStatement(part, context)) return true;
    const elided =
      lang === 'en'
        ? /^(?:(?:and|but|yet)\s+)?((?:does|do|did)\s+not\s.*)$/iu.exec(part)
        : /^(?:و|ف)?((?:لا|لم)\s.*)$/u.exec(part);
    if (elided === null) return false;
    return isSilenceStatement(`${lang === 'en' ? 'The document' : 'الوثيقة'} ${elided[1] ?? ''}`, context);
  };
  const sentences = sentencesOfAnswer(text);
  const uncited = sentences.filter(
    (sentence) => !sentence.cited && !isSilenceStatement(sentence.text, context),
  );
  const caveat = sentences.some((sentence) =>
    [
      sentence.text,
      ...clausesOf(sentence.text).flatMap((clause) => [clause, ...subClausesOf(clause, lang)]),
    ].some((part) => international.test(part) && silent(part)),
  );
  const invented: string[] = [];
  let named = false;
  for (const sentence of sentences) {
    const claimWords = aidWord.test(sentence.text) || eligibility.test(sentence.text);
    for (const clause of clausesOf(sentence.text)) {
      // a true statement of the document about housing for international students is no claim of aid
      if (housing.test(clause) && !aidWord.test(clause)) {
        if (international.test(clause)) named = true;
        continue;
      }
      for (const part of subClausesOf(clause, lang)) {
        const mentions = international.test(part);
        const standsFor = named && pronoun.test(part) && (aidWord.test(part) || eligibility.test(part));
        if (mentions) named = true;
        if ((mentions && claimWords) || standsFor) {
          if (!silent(part)) invented.push(sentence.text);
        }
      }
    }
  }
  const failures: (string | null)[] = [
    kinds >= 2
      ? null
      : `the answer names ${String(kinds)} of the 3 kinds of aid the document lists (expected at least 2)`,
    caveat
      ? null
      : 'the answer does not say, about the document, that it is silent about international students',
    invented.length === 0
      ? null
      : `the answer claims aid, or ineligibility, for international students that the document does not state: "${invented[0] ?? ''}"`,
    uncited.length === 0
      ? null
      : `an uncited sentence that is not a statement of the document's silence on the question: "${uncited[0]?.text ?? ''}"`,
    citedPages.includes(2) ? null : 'no citation of page 2 (the scholarships)',
  ];
  return failures.filter((failure): failure is string => failure !== null);
}

// --- an Arabic reply has no English in it (global §T.2) ------------------------------------------------------------------
//
// In the Arabic experience no English may appear: no framing ("The document states", "This suggests", "though the document does
// not say so directly"), no flourish ("Ah, seeker"), no sentinel text. Allowed: the [S#] markers, proper names and acronyms
// ("Tips Hindawi University", "Dr. Nabil Al-Khatib", "THU", "PDF", "Faculty of Engineering"), and document text quoted verbatim
// (pass the document's text, or the cited snippets, as `documentText`).

const STOCK_PHRASES =
  /not[\s_-]*(?:in[\s_-]*document|found)|the\s+(?:uploaded\s+|provided\s+)?(?:document|excerpts?|text)\s+(?:states?|says?|mentions?|does|notes|shows|indicates|lists|provides)|this\s+suggests|does\s+not\s+say|though\s+the\s+document|according\s+to\s+the\s+document|enough\s+information|ah,?\s+(?:seeker|traveler|traveller)/iu;
/** The English framing the answer prompt shows (rules 3 and 4), cut at its "...": none of it may reach an Arabic reply. */
const PROMPT_FRAMING = Object.values(FRAMING_PHRASES.en)
  .flatMap((phrase) => phrase.toLowerCase().split(/\s*\.\.\.\s*,?\s*|\s*\[s\d+\]\.?/u))
  .map((part) => part.replace(/[.\s]+$/u, '').trim())
  .filter((part) => part.split(' ').length >= 2);
/** English words that are never part of a name, capitalised or not (a name joiner between two capitalised words excepted). */
const ENGLISH_WORDS = new Set(
  `a an the and or but if then of to in on at by for with from into about as is are was were be been it its this that these those
   there here he she they them his her their we our you your i me my who what which when where why how can could would should
   will may might must not no nor so than too very just also only any some such each both either more most other does do did
   has have had document documents text excerpt excerpts page pages state states stated say says said mention mentions mentioned
   suggest suggests suggested indicate indicates directly explicitly information enough uploaded provided found seeker traveler
   traveller ah alas according however though although unfortunately sorry answer question yes`
    .split(/\s+/u)
    .filter((word) => word !== ''),
);
const NAME_JOINERS = new Set([
  'of',
  'and',
  'for',
  'the',
  'de',
  'al',
  'el',
  'bin',
  'ibn',
  'von',
  'van',
  'la',
  'le',
  'du',
  'da',
]);
/** A run of Latin-script words with only spaces and punctuation between them. */
const LATIN_RUN =
  /[\p{Script=Latin}][\p{Script=Latin}\p{N}'’.&%$-]*(?:[\s,;:()"“”/–-]+[\p{Script=Latin}\p{N}][\p{Script=Latin}\p{N}'’.&%$-]*)*/gu;
const squash = (text: string): string => text.toLowerCase().replace(/\s+/gu, ' ').trim();

/** What is wrong with an Arabic reply under global §T.2 (empty when it has no English in it). */
export function arabicReplyLatinFailures(text: string, documentText: readonly string[] = []): string[] {
  const failures: string[] = [];
  const reply = text.replace(MARKERS, ' ');
  const quoted = documentText.map(squash);
  for (const match of reply.matchAll(LATIN_RUN)) {
    const run = match[0].replace(/[\s,;:()"“”/.–-]+$/u, '');
    if (run === '' || quoted.some((source) => source.includes(squash(run)))) continue;
    // a Latin fragment glued to an Arabic word ("هندawi") is a transliteration slip inside that word, not English text
    const glued = /\p{Script=Arabic}/u.test(reply[match.index - 1] ?? ' ');
    if (STOCK_PHRASES.test(run) || PROMPT_FRAMING.some((phrase) => squash(run).includes(phrase))) {
      failures.push(`English framing in an Arabic reply: "${run}"`);
      continue;
    }
    const words = run
      .split(/[\s,;:()"“”/–]+/u)
      .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
    const capitalised = (word: string | undefined): boolean => word !== undefined && /^\p{Lu}/u.test(word);
    const english = words.find((word, index) => {
      if (word === '' || /\p{N}/u.test(word) || (glued && index === 0)) return false;
      const lower = word.toLowerCase();
      const joiner =
        NAME_JOINERS.has(lower) && capitalised(words[index - 1]) && capitalised(words[index + 1]);
      if (joiner) return false;
      return ENGLISH_WORDS.has(lower) || !capitalised(word);
    });
    if (english !== undefined) failures.push(`English text in an Arabic reply: "${run}"`);
  }
  return failures;
}
