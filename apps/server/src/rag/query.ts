import { normalizeForMatch, searchTerms } from '@enchanted/shared';
import { MAX_NAMED_PAGES, MAX_QUERY_TOKENS, MIN_TOKEN_CHARS } from './constants.js';
import { STOPWORDS } from './stopwords.js';

/** Query normalisation: NFKC, trimmed, every run of whitespace a single space. */
export function normalizeQuery(query: string): string {
  return query.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

const HAS_DIGIT = /\p{N}/u;
/** `ms4471`, `4471ms`: an identifier written without its separator; the index holds `ms 4471` when the source had a hyphen. */
const LETTERS_THEN_DIGITS = /^(\p{L}+)(\p{N}+)$/u;
const DIGITS_THEN_LETTERS = /^(\p{N}+)(\p{L}+)$/u;

/** The parts of a token that mixes letters and digits ("ms4471" -> "ms", "4471"), or none. */
function identifierParts(token: string): string[] {
  const match = LETTERS_THEN_DIGITS.exec(token) ?? DIGITS_THEN_LETTERS.exec(token);
  return match === null ? [] : [match[1] ?? '', match[2] ?? ''].filter((part) => part !== '');
}

/**
 * The words to look for in the full-text index: the shared search normaliser's surface words plus its extra recall
 * forms (Arabic light stems, CJK bigrams) of every text given, minus stopwords and one-letter words. Tokens that are
 * numbers or hold a digit are always kept ("1847", "ms 4471" gives "ms" and "4471"). Order of first appearance, no
 * duplicates, at most MAX_QUERY_TOKENS. Several texts are merged by union (the question as typed and its rewrite).
 */
export function queryTokens(...texts: readonly string[]): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    const { surface, extra } = searchTerms(text);
    for (const token of [...surface, ...extra]) {
      if (seen.has(token)) continue;
      const hasDigit = HAS_DIGIT.test(token);
      if (!hasDigit && (Array.from(token).length < MIN_TOKEN_CHARS || STOPWORDS.has(token))) continue;
      seen.add(token);
      tokens.push(token);
      if (tokens.length >= MAX_QUERY_TOKENS) return tokens;
      // An identifier is searched whole and in parts: whichever way the document wrote it, one of the forms is in its index.
      for (const part of identifierParts(token)) {
        if (seen.has(part) || tokens.length >= MAX_QUERY_TOKENS) continue;
        if (!HAS_DIGIT.test(part) && Array.from(part).length < MIN_TOKEN_CHARS) continue;
        seen.add(part);
        tokens.push(part);
      }
    }
  }
  return tokens;
}

// --- Page-directed questions -----------------------------------------------------------------------------

const ARABIC_INDIC_DIGITS = /[\u{0660}-\u{0669}\u{06F0}-\u{06F9}]/gu;
const toAscii = (text: string): string =>
  text.replace(ARABIC_INDIC_DIGITS, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });

/**
 * "page 12", "p. 12", "pp. 3-4", "pages 3 and 4", "page 3 to 5", Arabic "صفحة ١٢" / "الصفحة 12", French "page",
 * Spanish / Italian / Portuguese "página" / "pagina", German "Seite". Digits may be Arabic-Indic (converted first).
 * The word must start at a word edge (`map 3` is not a page reference), and the Arabic abbreviation "ص" must be
 * followed by digits.
 */
const PAGE_WORD = String.raw`(?:pages?|pp?\.?|pgs?\.?|p[aá]gina[s]?|seite[n]?|صفح[ةه]|صفحات|ص\.?)`;
const PAGE_REFERENCE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:ال)?${PAGE_WORD}\s*(?:no\.?|number|رقم|n[º°]|nr\.?)?\s*(\d{1,4})(?:\s*(?:-|–|—|to|and|&|et|y|und|e|الى|إلى|و)\s*(\d{1,4}))?(?![\p{L}\p{N}])`,
  'giu',
);

export interface PageReferences {
  /** The pages named, within 1..pageCount, in the order named, at most MAX_NAMED_PAGES. */
  pages: number[];
  /** The question with the page references cut out (so "12" does not become a search word). */
  remainder: string;
}

/** The pages a question names, and the question without those references. */
export function parsePageReferences(question: string, pageCount: number): PageReferences {
  const ascii = toAscii(question);
  const pages: number[] = [];
  const add = (page: number): void => {
    if (page >= 1 && page <= pageCount && !pages.includes(page) && pages.length < MAX_NAMED_PAGES) {
      pages.push(page);
    }
  };
  const remainder = ascii.replace(PAGE_REFERENCE, (match, first: string, second: string | undefined) => {
    const from = Number(first);
    const to = second === undefined ? from : Number(second);
    // "pages 3 and 5" names two pages; "3-5" names the range. Either way at most MAX_NAMED_PAGES.
    const isRange = /-|–|—|to|الى|إلى/iu.test(match.slice(match.indexOf(first) + first.length));
    if (isRange && to >= from && to - from < MAX_NAMED_PAGES) {
      for (let page = from; page <= to; page += 1) add(page);
    } else {
      add(from);
      if (second !== undefined) add(to);
    }
    return ' ';
  });
  return { pages, remainder: remainder.replace(/\s+/gu, ' ').trim() };
}

/**
 * Whether the question points at what the reader is looking at ("this page", "here", "what does this say"). Only then
 * do the visible pages count as hints. Heuristic, English / Arabic / French / Spanish / German.
 */
const DEICTIC_PAGE = [
  /(?<![\p{L}\p{N}])(?:this|these|current|visible|open(?:ed)?|opposite)\s+(?:page|pages|spread|passage|section|paragraph)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])on\s+(?:this|the\s+open)\s+page(?![\p{L}\p{N}])/iu,
  // a bare "here" / "هنا" is NOT a pointer to the page: it says nothing about where the answer is ("is it sold here?")
  /(?<![\p{L}\p{N}])(?:right\s+here\s+on\s+(?:the\s+)?page|here\s+on\s+(?:the\s+|this\s+)?(?:page|spread))(?![\p{L}\p{N}])/iu,
  /(?:هذه|هذي)\s+(?:الصفحة|الصفحات|الورقة|الفقرة|الفقره|الصفحه)|(?:الصفحة|الصفحات|الصفحه)\s+(?:الحالية|المفتوحة|الحاليه|المفتوحه)/u,
  /(?<![\p{L}\p{N}])(?:cette|ces|actuelle)\s+(?:page|pages|passage)/iu,
  /(?<![\p{L}\p{N}])(?:esta|estas|actual)\s+(?:p[aá]gina|p[aá]ginas|pasaje)/iu,
  /(?<![\p{L}\p{N}])(?:diese|dieser|aktuelle)\s+(?:seite|seiten|stelle)/iu,
];

export function refersToVisiblePages(question: string): boolean {
  return DEICTIC_PAGE.some((pattern) => pattern.test(question));
}

/**
 * The question with its page vocabulary taken out ("this page", "page", "spread", "passage", Arabic "هذه الصفحة" ...): what is
 * left says what the visitor wants to know ABOUT the page. Empty of informative words means the question only points
 * ("What does page 4 say?", "What is this page about?").
 */
export function withoutPageVocabulary(question: string): string {
  let rest = question;
  for (const pattern of DEICTIC_PAGE)
    rest = rest.replace(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`), ' ');
  return rest
    .replace(
      /(?<![\p{L}\p{N}])(?:pages?|spreads?|passages?|sections?|paragraphs?|الصفحة|الصفحات|صفحة|صفحات|الفقرة|فقرة|pagina|página|seite)(?![\p{L}\p{N}])/giu,
      ' ',
    )
    .replace(PAGE_TASK_WORDS, ' ');
}

/**
 * The words of a REQUEST ("summarize", "translate", "read", "list", "give", "talk", "tell", "show" ...), in the languages of the
 * product: what the visitor asks to be done, not what the document is about. They are not stopwords (a reading list is a list),
 * but they are not evidence either: a request word the document does not contain is not counted as a word of the question that
 * the document failed to cover (see `isTaskWord`), and they are ignored when the question names a page or asks for a summary.
 */
const TASK_WORD_LIST = `
  summarize summarise summarizing summarising summary overview translate translation read reads list lists give gives show shows
  talk talks tell tells explain explains describe describes say says said mean means contain contains cover covers discuss
  discusses outline display quote paraphrase extract extracts
  لخص لخصي تلخيص ملخص ملخصا اشرح اقرأ اقرا ترجم ترجمة تقول يقول تحتوي يحتوي تتحدث يتحدث تذكر يذكر اعرض اذكر اعطني أعطني
  résume résumer résumé resume traduis traduire lis lire dit dire
  resumen resumir lee leer dice decir traduce traducir
  fasse fassen zusammen zusammenfassung zusammenfassen lies lesen steht sagt übersetze
`;
export const TASK_WORDS: ReadonlySet<string> = new Set(
  TASK_WORD_LIST.split(/\s+/u)
    .filter((word) => word !== '')
    .map((word) => normalizeForMatch(word)),
);

/** Whether a search token is a word of a request ("summarize"), which a document does not have to contain. */
export const isTaskWord = (token: string): boolean => TASK_WORDS.has(token);

/**
 * What a visitor asks TO DO with a page, not what the page is about: "summarize page 2", "translate page 2", "read page 2",
 * "list the items on page 2", "give me a summary of page 2", "what does page 2 talk about / say", Arabic "لخص الصفحة 2", "ماذا
 * تقول الصفحة 2", French "résume", Spanish "resume", German "fasse zusammen". A request that names a page and adds only a task
 * asks nothing else: it points straight at the page's text, like "what does page 2 say?".
 */
const PAGE_TASK_WORDS = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:summari[sz]e|summari[sz]ing|summary|overview|translate|translation|read|reads|list|lists|give|gives|show|shows|talk|talks|tell|tells|say|says|said|describe|describes|explain|explains|mean|means|contain|contains|cover|covers|discuss|discusses|outline|display|quote|paraphrase|extract|extracts|items?|contents?|text|about|me|please|لخص|لخّص|لخصي|تلخيص|ملخص|ملخصا|اشرح|اقرأ|اقرا|ترجم|ترجمة|تقول|يقول|تحتوي|يحتوي|تتحدث|يتحدث|تذكر|يذكر|اعرض|اذكر|اعطني|أعطني|يوجد|توجد|موجود|محتوى|محتويات|r[ée]sum(?:e|er|[ée]s?)|lis|lire|dit|dire|traduis|traduire|r[ée]sume|resumen|resume|lee|leer|dice|decir|traduce|fasse|fassen|zusammen|zusammenfassen|zusammenfassung|lies|lesen|steht|sagt|[üu]bersetze)(?![\p{L}\p{N}])`,
  'giu',
);

// --- Capitalised words, meta questions ---------------------------------------------------------------------

const CAPITALISED = /(?<![\p{L}\p{N}])\p{Lu}[\p{L}\p{M}'’-]*/gu;

/**
 * The words of the question that are proper names (a capital letter that is not the start of the sentence), as search tokens:
 * a document that has "Thornquist" is about what was asked when the question says "Thornquist". Latin-script questions only
 * (Arabic has no capitals). Not every capitalised word is a name: a question written in Title Case ("What Is The Capital Of
 * Peru?") or in German (whose nouns are capitalised) has no way to tell, so it yields none. The value of each entry is the
 * name as written (the whole run of capitalised neighbours: "World Cup"), which the caller checks against the document's own
 * capitalisation: a brochure that has "World Bank" is not about a "World Cup".
 */
export function properNameForms(question: string): Map<string, string> {
  const names = new Map<string, string>();
  const text = question.normalize('NFC');
  const words = text.match(/(?<![\p{L}\p{N}])\p{L}[\p{L}\p{M}'’-]*/gu) ?? [];
  // a question in Title Case: its function words are capitalised too ("What Is The Capital Of Peru?")
  const capitalisedFunctionWords = words
    .slice(1)
    .filter((word) => /^\p{Lu}/u.test(word) && STOPWORDS.has(normalizeForMatch(word))).length;
  if (capitalisedFunctionWords >= 2) return names;
  // the capitalised words that do not start a sentence, in runs of neighbours ("World Cup", "Alaric Thornquist")
  const runs: { words: string[]; end: number }[] = [];
  for (const match of text.matchAll(CAPITALISED)) {
    const start = match.index;
    const before = text.slice(0, start).replace(/[\s"'«»“”([]+$/u, '');
    // the first word of the question or of a sentence is capitalised anyway
    if (before === '' || /[.!?¿¡:;]$/u.test(before)) continue;
    const word = match[0];
    if (Array.from(word).length < 3) continue;
    const last = runs.at(-1);
    if (last !== undefined && /^[ \t]+$/u.test(text.slice(last.end, start))) {
      last.words.push(word);
      last.end = start + word.length;
    } else {
      runs.push({ words: [word], end: start + word.length });
    }
  }
  for (const run of runs) {
    // a name of several words is one name: the document has to write the whole of it ("World Cup"), not one word of it
    const surface = run.words.join(' ');
    for (const word of run.words) {
      for (const token of normalizeForMatch(word).split(' ')) if (token !== '') names.set(token, surface);
    }
  }
  return names;
}

/** The proper-name search tokens of a question (see {@link properNameForms}). */
export function properNameTokens(question: string): Set<string> {
  return new Set(properNameForms(question).keys());
}

/**
 * A question about the document as a whole ("what is this document about?", "summarise it", "give me an overview", Arabic
 * "ما موضوع هذا المستند؟", "لخّص"): no passage answers it, the manuscript overview does. English, Arabic, French, Spanish,
 * German. Heuristic and on purpose narrow: a question that mentions a topic is never meta.
 */
/** Phrasings that are about the document as a whole by themselves ("what is this document about?"). */
const META_STRICT: readonly RegExp[] = [
  /(?<![\p{L}\p{N}])what(?:'s|\s+is|\s+are)?\s+(?:this|the|that)\s+(?:document|doc|pdf|file|book|text|paper|manuscript|article|report|diary|story|content)(?:\s+all)?\s+about(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])what\s+(?:does|do|did)\s+(?:this|the|that)\s+(?:document|doc|pdf|file|book|text|paper|manuscript|article|report)\s+(?:say|cover|contain|discuss|describe|deal\s+with)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])what(?:'s|\s+is)?\s+(?:in|inside)\s+(?:this|the)\s+(?:document|doc|pdf|file|book|text|paper|manuscript)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])what\s+is\s+it\s+about(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])what(?:'s|\s+is)\s+(?:this|the|that)\s+(?:document|doc|pdf|file|book|text|paper|manuscript|article|report|diary)\s*[?.!]?\s*$/iu,
  /(?<![\p{L}\p{N}])(?:tell|talk)\s+(?:me\s+)?about\s+(?:this|the|that)\s+(?:document|doc|pdf|file|book|text|paper|manuscript|article|report|diary)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])(?:describe|explain|introduce|outline)\s+(?:this|the|that)\s+(?:document|doc|pdf|file|book|text|paper|manuscript|article|report|diary)\s*[?.!]?\s*$/iu,
  // Arabic
  /(?:ما|ماذا)\s+(?:هو\s+|هي\s+)?(?:موضوع|محتوى|محتويات|فحوى)\s+(?:هذا|هذه|ال)?\s*(?:المستند|الوثيقة|الوثيقه|الملف|الكتاب|النص|المقال|التقرير|المخطوطة|الدفتر)/u,
  /(?:ما|ماذا)\s+(?:هو\s+|هي\s+)?(?:هذا|هذه)\s+(?:المستند|الوثيقة|الوثيقه|الملف|الكتاب|النص|المقال|التقرير|المخطوطة|الدفتر)\s*[؟?.!]?\s*$/u,
  /(?:عن\s+ماذا|عمّ|عم)\s+(?:يتحدث|تتحدث|يدور|تدور|يتكلم|تتكلم)(?![\p{L}\p{N}])/u,
  /(?:ما|ماذا)\s+(?:هو\s+|هي\s+)?(?:يقول|تقول|يحتوي|تحتوي)\s+(?:هذا\s+|هذه\s+)?(?:المستند|الوثيقة|الوثيقه|الملف|الكتاب|النص|المقال|التقرير|المخطوطة|الدفتر)/u,
  /(?:ما|ماذا)\s+(?:هي\s+)?(?:الفكرة|الفكره|الأفكار|الافكار|النقاط)\s+(?:الرئيسية|الرئيسيه|الأساسية|الاساسيه|الرئيسة)/u,
  // French, Spanish, German
  /(?<![\p{L}\p{N}])de\s+quoi\s+(?:parle|traite)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])que\s+dit\s+(?:ce|cet|cette|le|la)\s+(?:document|texte|pdf|fichier|livre)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])(?:de\s+qu[ée]\s+(?:trata|habla)|sobre\s+qu[ée]\s+(?:trata|es)|qu[ée]\s+dice\s+(?:este|el)\s+(?:documento|texto|pdf|libro))(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])worum\s+geht(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])was\s+steht\s+in\s+(?:diesem|dem|der)\s+(?:dokument|text|pdf|buch|datei)(?![\p{L}\p{N}])/iu,
];

/**
 * Phrasings that ask for a summary: about the whole document only when they name nothing more ("give me a summary", not
 * "summarise the section on tuition", not "summarise chapter 3").
 */
const META_LOOSE: readonly RegExp[] = [
  /(?<![\p{L}\p{N}])(?:summari[sz]e|summary|overview|tl;?dr|synopsis|abstract|gist)(?![\p{L}\p{N}])/giu,
  /(?<![\p{L}\p{N}])(?:main|key)\s+(?:points?|ideas?|topics?|themes?|takeaways?)(?![\p{L}\p{N}])/giu,
  /(?<![\p{L}\p{N}])(?:table\s+of\s+contents|outline)(?![\p{L}\p{N}])/giu,
  /(?<![\p{L}\p{N}])(?:لخّص|لخص|لخصي|تلخيص|ملخص(?:اً|ا)?|ملخّص(?:اً|ا)?|نظرة\s+عامة|خلاصة|الخلاصة)(?![\p{L}\p{N}])/gu,
  /(?<![\p{L}\p{N}])(?:r[ée]sum(?:e|er|[ée]s?)|aper[cç]u|synth[èe]se)(?![\p{L}\p{N}])/giu,
  /(?<![\p{L}\p{N}])(?:resum(?:e|en|ir)|visi[óo]n\s+general)(?![\p{L}\p{N}])/giu,
  /(?<![\p{L}\p{N}])(?:zusammenfass(?:en|ung)?|[üu]berblick|inhaltsangabe|zusammen)(?![\p{L}\p{N}])/giu,
];

const wordSet = (words: string): ReadonlySet<string> =>
  new Set(
    words
      .split(/\s+/u)
      .filter((word) => word !== '')
      .map((word) => normalizeForMatch(word)),
  );

/** The names of the document itself, in the languages of the product. */
const DOCUMENT_NOUNS = wordSet(`
  document doc pdf file book text paper manuscript article report diary story content contents
  المستند الوثيقة الوثيقه الملف الكتاب النص المقال التقرير المخطوطة الدفتر محتوى محتويات
  document texte fichier livre documento texto libro dokument buch datei
`);

/** The names of the languages a request may ask for ("in English"), bare and with the Arabic article / preposition. */
const LANGUAGE_NAMES = wordSet(`
  english arabic french spanish german italian portuguese turkish persian urdu
  العربية بالعربية الانجليزية الإنجليزية بالانجليزية بالإنجليزية الفرنسية بالفرنسية الاسبانية الإسبانية بالاسبانية بالإسبانية الالمانية الألمانية بالالمانية بالألمانية
  français anglais arabe espagnol allemand español inglés árabe francés alemán deutsch englisch arabisch französisch spanisch
`);

/**
 * Words that are no topic in a request about the document as a whole: the kinds of request ("give me a brief ..."), the names of
 * the document itself ("the text", "the PDF"), a language or a length ("in English", "in three sentences"), "the whole thing". What
 * else a request says is a TOPIC, and a request with a topic is an ordinary question: "what does the document say about
 * tuition?" and "summarise the scholarships" are answered from the passages about tuition and scholarships, not from an overview
 * that does not hold them.
 */
const META_FILLER: ReadonlySet<string> = new Set([
  ...DOCUMENT_NOUNS,
  ...LANGUAGE_NAMES,
  ...wordSet(`
  ${TASK_WORD_LIST}
  provide brief briefly short quick quickly whole entire full complete thing things everything anything all
  tl dr one paragraph sentences sentence lines
  اريد اكتب لي لهذا لهذه كامل كاملا بسرعة مختصر مختصرا موجز موجزا
  كله كلها بالكامل الكل باللغة اللغة
  donne moi fais bref brève courte
  dame hazme breve corto
  gib mir dir bitte kurz kurze diesem diesen dieses
  `),
]);

/** "in three sentences", "in 100 words", "في ثلاث جمل": a length asked for, which is no topic. */
const LENGTH_LIMIT =
  /(?<![\p{L}\p{N}])(?:in|within|under|using|with|about|around)\s+(?:no\s+more\s+than\s+|at\s+most\s+|up\s+to\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:sentences?|words?|points?|lines?|paragraphs?|bullets?|bullet\s+points?)(?![\p{L}\p{N}])|(?:في|ب)\s*(?:\d+|[٠-٩]+|ثلاث|ثلاثة|خمس|خمسة|عشر|عشرة)\s+(?:جمل|جملة|كلمات|كلمة|نقاط|أسطر|سطور|فقرات)/giu;

/** A word of a set, or the same with its Arabic article ("كتاب" for "الكتاب"): the light stem the search adds. */
const inSet = (set: ReadonlySet<string>, token: string): boolean =>
  set.has(token) || set.has(`ال${token}`) || (token.startsWith('ال') && set.has(token.slice(2)));

/** A filler word, or the light stem of one the search added for it (Arabic "كتاب" for "الكتاب"). */
const isFiller = (token: string): boolean => inSet(META_FILLER, token);

const WORD = /(?<![\p{L}\p{N}])\p{L}[\p{L}\p{M}'’-]*/gu;
const wordsOf = (text: string): string[] => (text.match(WORD) ?? []).map((word) => normalizeForMatch(word));

/**
 * "about tuition", "about English", "about translation", "عن الإنجليزية": what follows a word that introduces a subject IS the subject,
 * even when it is a word that is filler elsewhere (a language, a kind of request). The document's own names are the exception that
 * needs care: "a summary about the document" is about the document, but "what does the document say about the book?" names the
 * document already, so the book is something in it. The article is captured to tell "the document" from a bare "content".
 */
const SUBJECT_INTRODUCER =
  /(?<![\p{L}\p{N}])(?:about|on|regarding|concerning|عن|حول|بخصوص|بشأن)\s+((?:the|this|that|these|those|my|our|your)\s+)?(\p{L}[\p{L}\p{M}'’-]*)/giu;

/** What is a subject after an introducer: a language, a kind of request, or (named the document already, or bare) a document noun. */
function subjectsAfterIntroducer(rest: string, phraseNamesDocument: boolean): string[] {
  const subjects: string[] = [];
  for (const match of rest.matchAll(SUBJECT_INTRODUCER)) {
    const token = normalizeForMatch(match[2] ?? '');
    if (token === '') continue;
    const deictic = match[1] !== undefined || token.startsWith('ال');
    if (inSet(LANGUAGE_NAMES, token) || inSet(TASK_WORDS, token)) subjects.push(token);
    else if (inSet(DOCUMENT_NOUNS, token) && (phraseNamesDocument || !deictic)) subjects.push(token);
  }
  return subjects;
}

/** Words that stand for something said before ("about it", "عن ذلك"): a topic when there is an earlier question to resolve them from. */
const PRONOUNS = wordSet(`
  it its they them their he him his she her hers
  ذلك تلك عنه عنها عنهم عنهن فيه فيها به بها له لها
  cela ça ceci eso esto ello dazu darüber
`);
/** "this", "that" are a pronoun ("summarise that") unless a document noun follows ("this document"). */
const DEMONSTRATIVES = wordSet('this that these those هذا هذه هؤلاء');

/** Whether the words refer back to something said before. */
function refersBack(rest: string): boolean {
  const words = wordsOf(rest);
  return words.some((word, index) => {
    if (PRONOUNS.has(word)) return true;
    if (!DEMONSTRATIVES.has(word)) return false;
    const next = words[index + 1];
    return next === undefined || !(inSet(DOCUMENT_NOUNS, next) || /^pages?$/u.test(next));
  });
}

/** What a request leaves over once the phrase that made it a request about the whole document is cut out. */
function leftover(text: string, pattern: RegExp, followUp: boolean): string[] {
  const global = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  );
  const phrase = text.match(global)?.join(' ') ?? '';
  const rest = text.replace(global, ' ').replace(LENGTH_LIMIT, ' ');
  // a page named ("on page 2") is a place, and that is a topic too: its number and the word "page" stay
  const topical = queryTokens(rest).filter((token) => !isFiller(token));
  if (topical.length > 0) return topical;
  const subjects = subjectsAfterIntroducer(
    rest,
    wordsOf(phrase).some((word) => inSet(DOCUMENT_NOUNS, word)),
  );
  if (subjects.length > 0) return subjects;
  return followUp && refersBack(rest) ? ['(an earlier subject)'] : [];
}

/**
 * A question about the WHOLE document: one of the phrasings above, or a request for a summary, and NOTHING topical left over: no
 * topic word, no number, no name, no page. "What does the document say?" is meta; "What does the document say about tuition?"
 * and "Tell me about the text on page 2" are not.
 */
export function isMetaQuestion(question: string, options: { followUp?: boolean } = {}): boolean {
  const text = question.normalize('NFC');
  const followUp = options.followUp === true;
  return [...META_STRICT, ...META_LOOSE].some(
    (pattern) =>
      new RegExp(pattern.source, pattern.flags.replace('g', '')).test(text) &&
      leftover(text, pattern, followUp).length === 0,
  );
}
