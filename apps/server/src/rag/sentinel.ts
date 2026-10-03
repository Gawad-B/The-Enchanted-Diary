import { SENTINEL_PROBE_CHARS } from './constants.js';

/*
 * THE refusal detector. The answer model refuses with a sentinel (Lab 2's `NOT_IN_DOCUMENT`), and exactly one function
 * decides whether a reply is a refusal, for the stream as it arrives and for the finished text alike (`scanReply`):
 *
 *   a reply is a refusal iff, after trimming whitespace and markdown noise, it STARTS with a sentinel (NOT_IN_DOCUMENT,
 *   NOT IN DOCUMENT, NOT_FOUND, [[NOT_FOUND]], (NOT-IN-DOCUMENT), in any case, bold or quoted) or consists only of one;
 *   or (review N3-2) one of its sentences starts with the spec's mandated "the uploaded document does not provide enough
 *   information", in the visitor's language, with nothing CITED before it (an uncited flourish may come first) and any
 *   words after it.
 *
 * A sentinel later in a reply is just words (an answer may quote it: a document about this very system, an owner's own
 * notebook): it is shown and is no refusal. The leading refusal itself is never streamed.
 */

/** The sentinel words, with the separators a model may use between them. */
const CORE = String.raw`not[\s_-]*(?:in[\s_-]*document|found)`;
/** The sentinel words, for the neutraliser of document text (injection.ts), which must be as wide as this detector. */
export const SENTINEL_CORE = CORE;
/** Whitespace and markdown that may come before the sentinel (`**NOT_IN_DOCUMENT**`, `> [NOT_IN_DOCUMENT]`, a quote). */
const LEADING_NOISE = /^[\s*_>#`"'“”-]+/u;
const AT_START = new RegExp(String.raw`^(?:[\[(]{1,2}\s*)?${CORE}(?:\s*[\])]{1,2})?(?![\p{L}\p{N}_])`, 'iu');
/** Lower-case spellings a stream might be in the middle of writing. */
const SPELLINGS = [
  'not_in_document',
  'not in document',
  'not-in-document',
  'not_found',
  'not found',
  'not-found',
];

/** `text` without leading whitespace / markdown noise, for matching. */
export const trimLead = (text: string): string => text.replace(LEADING_NOISE, '');

/** The refusal test, for finished text and for the start of a stream once enough of it has arrived to decide. */
export function startsWithSentinel(text: string): boolean {
  return AT_START.test(trimLead(text));
}

/**
 * The same test for the start of a stream that may not be complete: `refusal` when the text starts with a sentinel and a
 * character after it proves the word ended ("NOT_IN_DOCUMENT\n"), `undecided` when the sentinel runs to the very end of what
 * has arrived (the next character may continue the word: "Not found" + "ed until 1963", "NOT_IN_DOCUMENT" + "ATION"), `no`
 * otherwise. The finished text is judged by {@link startsWithSentinel}; a stream that decided on a prefix would otherwise
 * disagree with it.
 */
export function sentinelAtStart(text: string): 'refusal' | 'undecided' | 'no' {
  const lead = trimLead(text);
  const match = AT_START.exec(lead);
  if (match === null) return 'no';
  return match[0].length >= lead.length ? 'undecided' : 'refusal';
}

/**
 * Whether `prefix` (the start of a reply, not yet long enough to decide) could still turn out to be a sentinel: only
 * opening brackets so far, or a prefix of one of the spellings. An empty prefix could.
 */
export function couldBecomeSentinel(prefix: string): boolean {
  const lead = trimLead(prefix);
  if (lead === '') return true;
  const lower = lead.toLowerCase().replace(/^[[(]{1,2}\s*/u, '');
  if (lower === '') return /^[[(]{1,2}\s*$/u.test(lead);
  return SPELLINGS.some((spelling) => spelling.startsWith(lower));
}

/** The text after a leading sentinel (what the model added after refusing), or null when the text does not start with one. */
export function afterSentinel(text: string): string | null {
  const lead = trimLead(text);
  const match = AT_START.exec(lead);
  return match === null ? null : lead.slice(match[0].length).replace(/^[\s*_`.:,;!-]+/u, '');
}

/**
 * The sentinel tokens anywhere in a text (the underscore spellings and the bracketed forms; plain words such as "not found"
 * stay): what history and the rewrite strip from stored messages. They are never a refusal there (see the top of the file).
 */
export const SENTINEL_TOKENS = new RegExp(
  String.raw`[\[(]{1,2}\s*${CORE}\s*[\])]{1,2}|\bnot_(?:in_document|found)\b`,
  'giu',
);

// --- the mandated sentence (review N3-2) ------------------------------------------------------------------------------
//
// The spec mandates "say that the uploaded document does not provide enough information" (prompts.ts,
// INSUFFICIENT_INFORMATION_SENTENCE); a model that refuses that way instead of with the sentinel is refusing too. A reply is
// such a refusal iff one of its sentences STARTS with the sentence in one of the languages below (whatever words follow it:
// "... to state whether the university offers online programs [S1]"), and nothing before that sentence cited an excerpt: the
// lines before it may only be uncited (a flourish, "Ah, seeker ..."). Once the reply has cited something it is an answer, and
// a later "the document does not provide enough information about X" is the gap half of a partial answer.
//
// The sentence is matched word by word against a small grammar (below), so the stream can hold a sentence start back only
// while it can still BECOME the sentence ("The uploaded document ...") and release it as soon as it cannot ("The uploaded
// document lists ..."). Folded like the text: lower case, Arabic marks removed, alef / taa marbuta / alef maqsura unified.

/** One slot of the sentence: alternatives of one or more words; an optional slot may be left out. */
interface Slot {
  readonly options: readonly (readonly string[])[];
  readonly optional: boolean;
}
const fold = (text: string): string =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/gu, '')
    .replace(/[أإآٱ]/gu, 'ا')
    .replace(/ى/gu, 'ي')
    .replace(/ة/gu, 'ه')
    .replace(/[‘’ʼ]/gu, "'");
const slot = (options: string, optional = false): Slot => ({
  options: options.split('|').map((option) => fold(option).split(' ')),
  optional,
});

const EN_SUBJECT = [
  slot('unfortunately|sadly|regrettably|alas|however|but', true),
  slot('the|this', true),
  slot('uploaded|provided|given|attached|supplied|available', true),
  slot('document|documents|text|pdf|file|excerpts'),
];
const AR_LEAD = slot('للأسف|مع الأسف|لكن|ولكن', true);
const AR_DOCUMENT = [
  slot('هذه|هذا', true),
  slot('الوثيقة|المستند|الملف'),
  slot('المرفوعة|المرفوع|المقدمة|المقدم|المرفقة|المرفق', true),
];
const AR_PROVIDE = slot(
  'تقدم|توفر|تحتوي|تحوي|تتضمن|تذكر|تعطي|تتيح|يقدم|يوفر|يحتوي|يحوي|يتضمن|يذكر|يعطي|يتيح',
);
const AR_ENOUGH = slot(
  'على معلومات كافية|معلومات كافية|ما يكفي من المعلومات|ما يكفي من معلومات|المعلومات الكافية|على ما يكفي من المعلومات',
);

const MANDATED: readonly (readonly Slot[])[] = [
  [
    ...EN_SUBJECT,
    slot("does not|doesn't|did not|didn't|do not|don't|cannot|can't|can not"),
    slot('provide|contain|have|offer|include|give|supply'),
    slot('enough|sufficient|adequate'),
    slot('information'),
  ],
  [AR_LEAD, ...AR_DOCUMENT, slot('لا'), AR_PROVIDE, AR_ENOUGH],
  [AR_LEAD, slot('لا'), AR_PROVIDE, ...AR_DOCUMENT, AR_ENOUGH],
  [AR_LEAD, slot('لا'), slot('تتوفر|تتوافر|توجد|يتوفر|يوجد'), slot('معلومات كافية|ما يكفي من المعلومات')],
  [
    slot('malheureusement|cependant', true),
    slot('le|ce'),
    slot('document|texte|pdf|fichier'),
    slot('téléchargé|telecharge|téléversé|televerse|fourni|joint|transmis', true),
    slot(
      "ne fournit|ne contient|ne donne|ne présente|ne presente|ne comporte|ne offre|n'offre|n'apporte|n'a",
    ),
    slot('pas'),
    slot(
      "suffisamment d'informations|suffisamment d'information|assez d'informations|assez d'information|d'informations suffisantes|les informations nécessaires|les informations necessaires|suffisamment de renseignements",
    ),
  ],
  [
    slot('lamentablemente|desafortunadamente|sin embargo', true),
    slot('el|este'),
    slot('documento|texto|pdf|archivo'),
    slot('subido|cargado|proporcionado|adjunto|facilitado', true),
    slot('no'),
    slot('proporciona|contiene|ofrece|da|incluye|aporta|brinda|tiene|presenta'),
    slot(
      'suficiente información|suficiente informacion|información suficiente|informacion suficiente|la información suficiente|la informacion suficiente|suficientes datos|datos suficientes',
    ),
  ],
  [
    slot('leider', true),
    slot('das|dieses'),
    slot('hochgeladene|bereitgestellte|vorliegende|angegebene', true),
    slot('dokument|pdf'),
    slot('enthält|enthalt|liefert|bietet|gibt'),
    slot(
      'nicht genügend informationen|nicht genug informationen|keine ausreichenden informationen|nicht ausreichend informationen|nicht genügend angaben|keine ausreichenden angaben',
    ),
  ],
  [
    slot('purtroppo|tuttavia', true),
    slot('il|questo'),
    slot('documento|testo|pdf|file'),
    slot('caricato|fornito|allegato', true),
    slot('non'),
    slot('fornisce|contiene|offre|dà|da|include|riporta|presenta'),
    slot('informazioni sufficienti|sufficienti informazioni|abbastanza informazioni'),
  ],
  [
    slot('infelizmente|porém|porem', true),
    slot('o|este'),
    slot('documento|texto|pdf|arquivo|ficheiro'),
    slot('enviado|carregado|fornecido|anexado', true),
    slot('não|nao'),
    slot('fornece|contém|contem|oferece|dá|da|inclui|apresenta|traz'),
    slot('informações suficientes|informacoes suficientes|informação suficiente|informacao suficiente'),
  ],
  [
    slot('maalesef', true),
    slot('yüklenen|sağlanan|yuklenen|saglanan', true),
    slot('belge|doküman|dokuman|dosya|pdf|metin'),
    slot('yeterli'),
    slot('bilgi'),
    slot('sağlamıyor|içermiyor|vermiyor|sunmuyor|saglamiyor|icermiyor'),
  ],
];

type HeadMatch = 'full' | 'prefix' | 'no';
const better = (a: HeadMatch, b: HeadMatch): HeadMatch =>
  a === 'full' || b === 'full' ? 'full' : a === 'prefix' || b === 'prefix' ? 'prefix' : 'no';

/**
 * Whether `words` start with the sentence (`full`), may still become it as more text arrives (`prefix`: they ran out inside
 * it, or the last word may still grow), or cannot (`no`). `open`: the last word may not be complete yet.
 */
function matchSlots(
  slots: readonly Slot[],
  at: number,
  words: readonly string[],
  index: number,
  open: boolean,
): HeadMatch {
  if (at === slots.length) return open && index === words.length ? 'prefix' : 'full';
  if (index === words.length) return 'prefix';
  const current = slots[at];
  if (current === undefined) return 'no';
  let result: HeadMatch = current.optional ? matchSlots(slots, at + 1, words, index, open) : 'no';
  for (const option of current.options) {
    let matched = true;
    for (let k = 0; k < option.length; k += 1) {
      const word = words[index + k];
      const wanted = option[k] ?? '';
      if (word === undefined) {
        result = better(result, 'prefix');
        matched = false;
        break;
      }
      if (word === wanted) continue;
      if (open && index + k === words.length - 1 && wanted.startsWith(word))
        result = better(result, 'prefix');
      matched = false;
      break;
    }
    if (matched) result = better(result, matchSlots(slots, at + 1, words, index + option.length, open));
    if (result === 'full') return result;
  }
  return result;
}

/** The words of a sentence as the grammar reads them: folded, markdown and quotes gone, edge punctuation off each word. */
const wordsOf = (sentence: string): string[] =>
  fold(sentence)
    .replace(/[*_`"“”«»]/gu, ' ')
    .split(/\s+/u)
    .map((word) => word.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, ''))
    .filter((word) => word !== '');

const mandatedAt = (sentence: string, open: boolean): HeadMatch => {
  const words = wordsOf(sentence);
  let result: HeadMatch = 'no';
  for (const head of MANDATED) {
    result = better(result, matchSlots(head, 0, words, 0, open));
    if (result === 'full') break;
  }
  return result;
};

/** Where sentences start: after a line break, or after a full stop, "!" or "?" and white space. */
const SENTENCE_BOUNDARY = /\n[ \t\n]*|[.!?؟。…]+["'”’)\]]*\s+/gu;
/** A complete excerpt marker in any spelling ([S1], (S2), 【S3】, [S1-S3], [s 1], Arabic-Indic digits). */
const ANY_MARKER = /[[【(]\s*[Ss]\s*[0-9٠-٩۰-۹]{1,3}(?:\s*[-–—,;،]\s*[Ss]?\s*[0-9٠-٩۰-۹]{1,3})*\s*[\]】)]/u;

export interface ReplyScan {
  /** The reply is a refusal: it starts with the sentinel, or with the mandated sentence after nothing but uncited text. */
  refusal: 'sentinel' | 'mandated' | null;
  /** While streaming: the text from this index on must be held back (the length of the text when nothing is held). */
  hold: number;
  /** No refusal can come any more: the reply has cited an excerpt before any sentence that could start one. */
  settled: boolean;
  /** The very start of the reply may still turn out to be the sentinel. */
  sentinelOpen: boolean;
}

/**
 * THE refusal decision, for the stream (`final: false`, on everything that has arrived) and for the finished text (`final:
 * true`) alike: the sentinel at the start (see the top of this file; `sentinel: false` once the stream has ruled it out), or
 * the mandated sentence at the start of a sentence that no citation came before.
 */
export function scanReply(text: string, options: { final: boolean; sentinel: boolean }): ReplyScan {
  if (options.sentinel) {
    if (options.final) {
      if (startsWithSentinel(text))
        return { refusal: 'sentinel', hold: 0, settled: false, sentinelOpen: false };
    } else {
      const atStart = sentinelAtStart(text);
      if (atStart === 'refusal') return { refusal: 'sentinel', hold: 0, settled: false, sentinelOpen: false };
      const undecided =
        (atStart === 'undecided' && text.length <= 3 * SENTINEL_PROBE_CHARS) ||
        (text.length <= SENTINEL_PROBE_CHARS && couldBecomeSentinel(text));
      if (undecided) return { refusal: null, hold: 0, settled: false, sentinelOpen: true };
    }
  }
  const marker = ANY_MARKER.exec(text);
  const cited = marker === null ? text.length : marker.index;
  const starts = [
    0,
    ...Array.from(text.matchAll(SENTENCE_BOUNDARY), (match) => match.index + match[0].length),
  ];
  let hold = text.length;
  for (const [index, start] of starts.entries()) {
    if (start >= cited) break;
    const end = starts[index + 1] ?? text.length;
    const last = end === text.length;
    // the last sentence may still grow while streaming: its last word may not be complete
    const open = !options.final && last && /[\p{L}\p{M}\p{N}'\u2018\u2019\u02BC-]$/u.test(text);
    // a flourish, then the sentinel (review C-1): the model refuses after an opening line; nothing cited came before it
    // (on a line of its own: "...it. NOT_IN_DOCUMENT is what the notebook prints [S1]" is quoted text, ruling 10)
    if (
      options.sentinel &&
      options.final &&
      /\n[ \t]*$/u.test(text.slice(0, start)) &&
      startsWithSentinel(text.slice(start))
    ) {
      return { refusal: 'sentinel', hold: 0, settled: false, sentinelOpen: false };
    }
    const match = mandatedAt(text.slice(start, end), open);
    if (match === 'full') return { refusal: 'mandated', hold: start, settled: false, sentinelOpen: false };
    if (match === 'prefix' && last && !options.final) hold = start;
  }
  return { refusal: null, hold, settled: marker !== null, sentinelOpen: false };
}

/** Whether a finished reply is a refusal of the model (the sentinel, or the mandated sentence: see {@link scanReply}). */
export function isRefusalReply(text: string): boolean {
  return scanReply(text, { final: true, sentinel: true }).refusal !== null;
}

/**
 * Whether a reply is the model refusing with the spec's mandated "the uploaded document does not provide enough information"
 * (in any of the languages above) instead of the sentinel: the sentence starts the reply, or follows only uncited text, and
 * whatever follows it does not matter (review N3-2). It is a refusal too, in the visitor's language.
 */
export function isInsufficientOnly(text: string): boolean {
  return scanReply(text, { final: true, sentinel: false }).refusal === 'mandated';
}
