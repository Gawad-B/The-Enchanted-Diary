import { searchTerms } from '@enchanted/shared';
import { STOPWORDS } from './stopwords.js';

/*
 * The one kind of sentence that may stay in an answer without a citation: a statement about the document's SILENCE on the
 * question ("However, the document does not state whether international students are eligible"). It has nothing to cite, and
 * it is the half of a partial answer that names the missing qualifier. Everything else that cites nothing is not the document
 * speaking (a flourish, an "Audit: ..." line, a claim the model made up) and is dropped (reply.ts).
 *
 * The exemption is an anchored TEMPLATE that the WHOLE sentence must match (review N-2, final design):
 *  1. the shape: an optional lead-in ("However,", "Note that", "لكن", "Cependant," ...), then ONE clause whose subject is the
 *     document or what was read of it (the document, the excerpts, the text, the pages, the manuscript; الوثيقة, المستند, النص,
 *     المقتطفات ...), or "it"/"they"/هي/لكنها with a SAYING verb only (state, mention, specify, say, indicate, clarify; تذكر،
 *     توضح، تحدد، تنص، تشير)—never with provide/offer/include/cover/تقدم/تتضمن, whose subject is usually the university—or an
 *     impersonal "there is no information", "it is not stated whether", "لا يتضح من الوثيقة", "من غير المحدد في الوثيقة";
 *     a NOT-state verb; and a tail that is nothing, a whether/if/wh- complement, or a short noun phrase. One clause only: no
 *     ; : — or second sentence, no clause linker (but, so, because, which ...; لكن، لذا، لأن ...), a comma only before
 *     whether/if/ما إذا/هل; a "that"-clause ("does not mention that refunds are impossible") is a claim, not a silence. At most
 *     35 words. English, Arabic (the natural forms too: لم تذكر، لا يتضح من، من غير المحدد في), French, Spanish and German;
 *  2. no web or e-mail address, no phone number or other run of 4+ digits, no second person and no order (you, please, must,
 *     contact, visit; عليك، يرجى، زوروا، تواصلوا ...);
 *  3. what it says the document is silent about is the visitor's own question: at least 60% of the content words of the tail
 *     are words of the question as typed or of its successful rewrite (folded: case, Arabic letter forms, light stems).
 *     "whether international students can live on campus" is not a gap of "is there financial aid for international
 *     students?", and without a question only a tail with no content word ("The document does not say so.") can stay.
 * The caller allows at most two of them in a reply, and only after something cited. A sentence that fits none of this is
 * dropped, including some honest hedges ("This suggests ..., though the document does not say so directly"): that is the
 * price of a rule an injected page cannot talk its way through.
 */

// --- folding --------------------------------------------------------------------------------------------------------

const ARABIC_MARKS = /[\u064B-\u065F\u0670\u0640]/gu;
const ARABIC_INDIC = /[٠-٩۰-۹]/gu;

/**
 * Lower case, NFKC, Arabic marks and tatweel removed, the Arabic letter variants unified (alef forms, alef maqsura, taa
 * marbuta, the Persian kaf and yeh), Arabic-Indic digits made ASCII, curly apostrophes straight. Punctuation is KEPT (the
 * template reads it); the patterns below are written through the same function.
 */
export function foldText(text: string): string {
  return foldLetters(
    text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/\p{Cf}/gu, ''),
  )
    .replace(ARABIC_INDIC, (digit) => {
      const code = digit.charCodeAt(0);
      return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
    })
    .replace(/\s+/gu, ' ')
    .trim();
}

/** The letter folding alone (no case, no spacing): safe on a regular expression's source too. */
function foldLetters(text: string): string {
  return text
    .replace(ARABIC_MARKS, '')
    .replace(/[أإآٱ]/gu, 'ا')
    .replace(/ى/gu, 'ي')
    .replace(/ة/gu, 'ه')
    .replace(/ک/gu, 'ك')
    .replace(/[یې]/gu, 'ي')
    .replace(/[‘’ʼ]/gu, "'");
}

/** A pattern written as people write the words (in lower case), folded like the text it reads. */
const rx = (source: string, flags = 'u'): RegExp => new RegExp(foldLetters(source), flags);

// --- the question's words -------------------------------------------------------------------------------------------

/** The folded word forms of the visitor's question (as typed, plus the model's rewrite when it succeeded). */
export interface QuestionContext {
  readonly forms: ReadonlySet<string>;
}

const ARABIC_WORD = /^\p{Script=Arabic}+$/u;
const ARABIC_PREFIX = /^(?:[وف]?[بكل]?ال|[وف]?لل)/u;
const ARABIC_SUFFIX = /(?:ين|ون|ات|ان|يه|ها|هم|ه|ا)$/u;
const LATIN_WORD = /^\p{Script=Latin}+$/u;

/** A word and its light stems (Arabic article and plural/feminine endings; English plural and -ing/-ed), for matching only. */
function formsOf(token: string): string[] {
  const forms = new Set([token]);
  if (ARABIC_WORD.test(token)) {
    const prefix = ARABIC_PREFIX.exec(token);
    const bare =
      prefix !== null && token.length - prefix[0].length >= 3 ? token.slice(prefix[0].length) : token;
    forms.add(bare);
    for (const word of [token, bare]) {
      const suffix = ARABIC_SUFFIX.exec(word);
      if (suffix !== null && word.length - suffix[0].length >= 3) forms.add(word.slice(0, -suffix[0].length));
    }
  } else if (LATIN_WORD.test(token)) {
    if (token.length > 4 && token.endsWith('ies')) forms.add(`${token.slice(0, -3)}y`);
    if (token.length > 4 && token.endsWith('es')) forms.add(token.slice(0, -2));
    if (token.length > 3 && token.endsWith('s')) forms.add(token.slice(0, -1));
    if (token.length > 5 && token.endsWith('ing')) forms.add(token.slice(0, -3));
    if (token.length > 4 && token.endsWith('ed')) forms.add(token.slice(0, -2));
  }
  return [...forms];
}

/** The context of a turn: the words of the question as typed and of its SUCCESSFUL rewrite (pass null for none). */
export function questionContext(...texts: readonly (string | null | undefined)[]): QuestionContext {
  const forms = new Set<string>();
  for (const text of texts) {
    if (text === null || text === undefined) continue;
    for (const token of searchTerms(text).surface) for (const form of formsOf(token)) forms.add(form);
  }
  return { forms };
}

/**
 * Words that say nothing about WHAT the document is silent about: hedges ("specifically", صراحة، تحديدًا، مخصص), the
 * document's own nouns, "whether", "available", "information". They are left out of the coverage measure (rule 3).
 */
const FILLER: ReadonlySet<string> = new Set(
  `whether specifically specific explicitly explicit particularly particular directly direct clearly clear exactly precisely
   expressly actually really even available availability offered provided given applicable mentioned stated specified
   information info details detail detailed anything something nothing mention reference indication statement word whatsoever
   else further more either document documents excerpt excerpts text texts passage passages page pages manuscript pdf file
   diary source sources material materials uploaded
   صراحه صراحتا بصراحه صريح صريحه تحديدا بالتحديد التحديد تحديد وجه الخصوص بشكل بصفه بصوره نحو واضح واضحه بوضوح مباشر مباشره
   محدد مخصص مخصصه مخصصا المخصص المخصصه خصيصا تخصيصا خاص خاصه متاح متاحه متاحا المتاح المتاحه متوفر متوفره متوفرا معلومات معلومه
   المعلومات تفاصيل اشاره ذكر شيء شيئا الوثيقه وثيقه المستند مستند النص الملف المقتطفات المقتطف الصفحات الكتاب المخطوطه ام عما
   حول بشان بخصوص فيما يتعلق يخص اذا
   si précisément precisement explicitement clairement directement document texte fichier extrait extraits informations
   information précision precision
   explícitamente explicitamente claramente expresamente documento texto archivo información informacion
   ob ausdrücklich ausdrucklich explizit genau näher naher dokument text datei angaben informationen darüber daruber dazu`
    .split(/\s+/u)
    .filter((word) => word !== '')
    .map((word) => foldText(word).replace(/['’]/gu, '')),
);

/** The content words of a tail: no stopword, no filler, no one-letter word (a number always counts). */
function contentTokens(text: string): string[] {
  return searchTerms(text).surface.filter(
    (token) =>
      /\p{N}/u.test(token) || (Array.from(token).length >= 2 && !STOPWORDS.has(token) && !FILLER.has(token)),
  );
}

/** Rule 3: at least 60% of the tail's content words are the question's (a tail with none is no claim at all). */
function coveredByQuestion(tail: string, question: QuestionContext | null | undefined): boolean {
  const tokens = contentTokens(tail);
  if (tokens.length === 0) return true;
  const forms = question?.forms ?? new Set<string>();
  const covered = tokens.filter((token) => formsOf(token).some((form) => forms.has(form))).length;
  return covered / tokens.length >= COVERAGE;
}

const COVERAGE = 0.6;
const MAX_WORDS = 35;
const MAX_NOUN_PHRASE_WORDS = 8;

// --- rule 2: what no silence statement may hold ---------------------------------------------------------------------

/** An address, a host name, a phone number or any other run of four digits or more. */
const ADDRESS = rx(
  [
    String.raw`https?:\/\/|www\.|\S@\S`,
    String.raw`[\p{L}\p{N}-]+\.[a-z]{2,24}(?![\p{L}\p{N}])`,
    String.raw`\[\.\]|\(\.\)|\[dot\]|\(dot\)|\[at\]|\(at\)`,
    String.raw`\s(?:dot|نقطه)\s+[a-z]{2,6}\b`,
    String.raw`\d(?:[\s.,'٬٫()-]?\d){3,}`,
  ].join('|'),
  'iu',
);

/** Second person, first person plural and orders: never in a statement about what a document says. */
const PERSON_OR_ORDER: Record<Language, RegExp> = {
  en: rx(
    String.raw`\b(?:you|your|yours|yourself|yourselves|u|ur|ya|y'all|we|us|our|ours|let's|please|kindly|pls|plz|must|should|ought)\b`,
    'iu',
  ),
  ar: rx(
    String.raw`(?:^|\s)[وف]?(?:عليك|عليكم|عليكي|لك|لكم|انت|انتم|انتي|يمكنك|يمكنكم|بامكانك|ننصح|ننصحك|ننصحكم|نوصي|نوصيك|نوصيكم|يرجى|نرجو|الرجاء|رجاء|يجب|ينبغي|تجاهل|تجاهلوا|تجاهلي|اكتب|اكتبوا|اكتبي|اجب|اجيبوا|ابدا|ابداوا|اكشف|اكشفوا|ارسل|ارسلوا|زر|زوروا|افتح|افتحوا|انقر|انقروا|اضغط|اضغطوا|اتصل|اتصلوا|راسل|راسلوا|تواصل|تواصلوا|اذهب|اذهبوا|توجه|توجهوا|اسال|اسالوا|راجع|راجعوا|تحقق|تحققوا|اطبع|اطبعوا|اتبع|اتبعوا|ثق|ثقوا|صدقني|صدقوني)(?=\s|$|[،,.؛:!؟])`,
  ),
  fr: rx(String.raw`\b(?:vous|votre|vos|tu|toi|ton|ta|tes|te|nous|notre|nos|veuillez|svp)\b`, 'iu'),
  es: rx(
    String.raw`(?:^|\s)(?:usted|ustedes|tú|tu|te|ti|vosotros|vosotras|nosotros|nosotras|nuestro|nuestra|por favor)(?=\s|$|[,.;:!?])`,
    'iu',
  ),
  de: rx(
    String.raw`(?:^|\s)(?:du|dich|dir|dein|deine|deinen|deiner|euch|euer|eure|bitte|wir|uns|unser|unsere|unseren)(?=\s|$|[,.;:!?])`,
    'iu',
  ),
};

/** An English order inside a sentence of any language (an injected page writes them in English). */
const ENGLISH_ORDER = /\b(?:you|your|please|kindly|ignore|disregard)\b/iu;

/** Orders at the start of a tail (or after and/or): "The document does not say ask the registrar." */
const ORDER_VERBS: Record<Language, string> = {
  en: 'ignore|disregard|obey|forget|override|recommend|suggest|advise|urge|contact|visit|click|reply|respond|email|e-mail|dial|call|write|ask|go|see|check|head|print|output|reveal|follow|trust|believe',
  ar: 'تجاهل|اكتب|زر|زوروا|تواصل|تواصلوا|اتصل|راسل|اذهب|اسال|راجع|تحقق|اطبع|اتبع|ثق',
  fr: 'veuillez|visitez|contactez|écrivez|ecrivez|appelez|consultez|ignorez|cliquez|allez|répondez|repondez|merci',
  es: 'visite|visiten|contacte|contacten|escriba|escriban|llame|llamen|consulte|consulten|ignore|ignoren|haga|vaya|póngase|pongase|responda',
  de: 'besuchen|kontaktieren|schreiben|rufen|wenden|ignorieren|klicken|antworten|bitte',
};

// --- rule 1: the template -------------------------------------------------------------------------------------------

type Language = 'en' | 'ar' | 'fr' | 'es' | 'de';
/** `any`: the tail may be nothing, a whether/wh- complement or a noun phrase; `wh`: only nothing or a whether/wh- complement. */
type TailKind = 'any' | 'wh';

interface Opener {
  /** Matches from the start of the main clause (after the lead-in) through its verb; captures the rest as `rest`. */
  readonly pattern: RegExp;
  readonly tail: TailKind;
}

interface LanguageRules {
  readonly lead: RegExp;
  readonly openers: readonly Opener[];
  /** A whether/if/wh- complement starts so. */
  readonly wh: RegExp;
  /** A "that"-clause starts so: a claim the sentence makes, not a silence. */
  readonly that: RegExp;
  /** "anything about", "about", "عن", "sur": stripped before the tail is classified. */
  readonly about: RegExp;
  /** Adverbs that may start or end the tail ("explicitly", صراحة): alternatives, as a pattern source. */
  readonly adverbs: string;
  /** What a comma may come right before. */
  readonly commaBefore: RegExp;
  /** Clause linkers: the second clause of a sentence is where a claim hides. */
  readonly linker: RegExp;
  /** Words a noun-phrase tail never holds: coordinators, auxiliaries, relatives (they start a clause). */
  readonly notInNounPhrase: RegExp;
}

const word = (alternatives: string): string => `(?:${alternatives})`;
const END = String.raw`(?<rest>(?:[\s,،].*)?)$`;

// English ---------------------------------------------------------------------------------------------------------------
const EN_ADVERBS = String.raw`(?:(?:explicitly|specifically|clearly|directly|actually|really|even|expressly|precisely|exactly|further|also|otherwise|anywhere)\s+)*`;
const EN_DOC = String.raw`(?:the|this|these|those|that)\s+(?:(?:uploaded|provided|given|available|retrieved|attached|supplied|quoted|cited|relevant|above|same)\s+)?(?:document|documents|excerpt|excerpts|text|texts|passage|passages|page|pages|manuscript|pdf|file|diary|source|sources|material|materials)`;
const EN_DOC_VERBS = {
  base: 'state|mention|specify|say|indicate|include|list|address|describe|confirm|name|define|detail|clarify|explain|discuss|cover|provide|give|contain|offer|elaborate(?:\\s+on)?|go\\s+into(?:\\s+detail)?|spell\\s+out|make\\s+clear|tell|identify|note|outline|set\\s+out|establish|show',
  participle:
    'stated|mentioned|specified|said|indicated|included|listed|addressed|described|confirmed|named|defined|detailed|clarified|explained|discussed|covered|provided|given|contained|offered|told|identified|noted|outlined|established|shown',
  third:
    'states|mentions|specifies|says|indicates|includes|lists|addresses|describes|confirms|names|defines|details|clarifies|explains|discusses|covers|provides|gives|contains|offers|tells|identifies|notes|outlines|establishes|shows',
};
/** The verbs "it" and "they" may take: saying verbs only (with a world verb the pronoun is the university, not the document). */
const EN_SAY_VERBS = {
  base: 'state|mention|specify|say|indicate|clarify|explain|confirm|tell|make\\s+clear|spell\\s+out',
  participle: 'stated|mentioned|specified|said|indicated|clarified|explained|confirmed|told|made\\s+clear',
  third: 'states|mentions|specifies|says|indicates|clarifies|explains|confirms|tells|makes\\s+clear',
};
const enNegated = (verbs: { base: string; participle: string; third: string }): string =>
  String.raw`(?:(?:does|do|did)\s*(?:not|n't)\s+${EN_ADVERBS}${word(verbs.base)}|(?:has|have)\s*(?:not|n't)\s+${EN_ADVERBS}${word(verbs.participle)}|never\s+${EN_ADVERBS}${word(verbs.third)})`;
const EN_IN_DOC = String.raw`(?:\s+(?:in|within|by|from)\s+the\s+(?:uploaded\s+|provided\s+)?(?:document|text|excerpts?|pages?|manuscript))?`;

const ENGLISH: LanguageRules = {
  lead: rx(
    String.raw`^(?:however|but|yet|still|also|additionally|unfortunately|importantly|notably|nevertheless|nonetheless|moreover|furthermore|in addition|that said|that being said|admittedly|sadly|note that|please note(?: that)?|it is worth noting that|it should be noted that|to be clear)\s*,?\s+`,
  ),
  openers: [
    { pattern: rx(String.raw`^${EN_DOC}\s+${enNegated(EN_DOC_VERBS)}${END}`), tail: 'any' },
    { pattern: rx(String.raw`^(?:it|they)\s+${enNegated(EN_SAY_VERBS)}${END}`), tail: 'any' },
    {
      // "is silent on", "says nothing about", "makes no mention of"
      pattern: rx(
        String.raw`^(?:${EN_DOC}|it|they)\s+(?:(?:is|are|was|were|remains?)\s+silent\s+(?:on|about|regarding|as\s+to)|(?:says|say|states|state|mentions|mention|specifies|specify)\s+nothing(?:\s+(?:about|on|regarding|concerning|of))?|makes?\s+no\s+(?:mention|reference|statement)\s+(?:of|about|regarding|as\s+to))${END}`,
      ),
      tail: 'any',
    },
    {
      pattern: rx(
        String.raw`^it\s+is\s*(?:not|n't)\s+${EN_ADVERBS}(?:stated|mentioned|specified|said|indicated|made\s+clear|clarified|explained|confirmed|clear\s+from\s+the\s+(?:uploaded\s+)?(?:document|text|excerpts?))${EN_IN_DOC}${END}`,
      ),
      tail: 'wh',
    },
    {
      pattern: rx(
        String.raw`^it\s+is\s+unclear\s+from\s+the\s+(?:uploaded\s+)?(?:document|text|excerpts?)${END}`,
      ),
      tail: 'wh',
    },
    {
      pattern: rx(
        String.raw`^there\s+(?:is|are|was|were)\s+no\s+(?:(?:further|specific|explicit|clear)\s+)?(?:information|mention|indication|reference|details?|word|statement|data)${EN_IN_DOC}${END}`,
      ),
      tail: 'any',
    },
    {
      pattern: rx(
        String.raw`^no\s+(?:(?:further|specific)\s+)?(?:information|mention|details?|indication)\s+(?:is|are|was|were)\s+(?:given|provided|stated|available|found|made|included)${EN_IN_DOC}${END}`,
      ),
      tail: 'any',
    },
    {
      pattern: rx(
        String.raw`^nothing\s+(?:(?:is|was)\s+)?(?:said|stated|mentioned|specified|written)${EN_IN_DOC}${END}`,
      ),
      tail: 'any',
    },
  ],
  wh: rx(
    String.raw`^(?:whether|if|who|whom|whose|what|which|when|where|why|how|(?:for|to|by|from|with|in)\s+(?:whom|which|what))\b`,
  ),
  that: rx(
    String.raw`^that\s+(?!(?:detail|information|point|matter|fact|requirement|condition|issue|aspect|part|question)\b)\S`,
  ),
  about: rx(
    String.raw`^(?:(?:anything|much|any\s+(?:information|details?|mention)|information|details?|any(?:thing)?\s+(?:else|more|further))\s+)?(?:about|on|regarding|concerning|as\s+to)\s+`,
  ),
  adverbs: String.raw`explicitly|specifically|clearly|directly|expressly|precisely|exactly|at\s+all|either|anywhere|in\s+(?:the|this)\s+(?:uploaded\s+)?(?:document|text|excerpts?|pages?)`,
  commaBefore: rx(String.raw`^\s*(?:whether|if|or\s+not)\b`),
  linker: rx(
    String.raw`\b(?:but|yet|because|since|although|though|while|whereas|unless|therefore|thus|hence|instead|however|meanwhile|otherwise|nor|so\s+that|and\s+so|then)\b`,
  ),
  notInNounPhrase: rx(
    String.raw`\b(?:and|or|&|is|are|was|were|be|been|being|am|can|could|will|would|shall|should|may|might|must|do|does|did|has|have|had|isn't|aren't|wasn't|weren't|can't|cannot|won't|wouldn't|doesn't|don't|didn't|hasn't|haven't|hadn't|which|who|whom|whose|that|where|when|so)\b`,
  ),
};

// Arabic ---------------------------------------------------------------------------------------------------------------
const AR_DOC = String.raw`(?:(?:هذه|هذا)\s+)?(?:الوثيقة|المستند|النص|الملف|المخطوطة|المقتطفات|المقتطف|الصفحات|الصفحة|الكتاب|المصدر|المصادر)(?:\s+(?:المرفوعة|المرفوع|المقدمة|المقدم|المرفقة|المرفق|المتاحة|المتاح|الحالية|الحالي))?`;
/** A not-state verb after لا (indicative) or لم (jussive), with an optional object pronoun (يذكره، تذكرها). */
const AR_DOC_VERBS = String.raw`(?:تذكر|يذكر|توضح|يوضح|تحدد|يحدد|تنص|ينص|تشير|يشير|تشر|يشر|تبين|يبين|تصرح|يصرح|تتطرق|يتطرق|تتناول|يتناول|تقدم|يقدم|تتضمن|يتضمن|تحتوي|يحتوي|تحتو|يحتو|تحوي|يحوي|تفصل|يفصل|تورد|يورد|تؤكد|يؤكد|تشرح|يشرح|تعطي|يعطي|تعط|يعط|توفر|يوفر|تعرض|يعرض)(?:ه|ها|هم|هما)?`;
const AR_SAY_VERBS = String.raw`(?:تذكر|يذكر|توضح|يوضح|تحدد|يحدد|تنص|ينص|تشير|يشير|تشر|يشر|تبين|يبين|تصرح|يصرح|تؤكد|يؤكد|تشرح|يشرح)(?:ه|ها|هم|هما)?`;
const AR_PRONOUN = String.raw`(?:لكنها|لكنه|ولكنها|ولكنه|غير\s+انها|غير\s+انه|الا\s+انها|الا\s+انه|انها|انه|هي|هو|وهي|وهو)`;
const AR_ADVERB = String.raw`(?:(?:بشكل|بصفة|بصورة|على\s+نحو)\s+(?:صريح|صريحة|واضح|واضحة|مباشر|مباشرة|محدد|محددة|دقيق)|صراحة|صراحتا|بصراحة|بوضوح|تحديدا|بالتحديد|على\s+وجه\s+(?:التحديد|الخصوص)|ايضا|كذلك)`;
const AR_NOT = String.raw`(?:لا|لم)`;
const AR_INFO = String.raw`(?:معلومات|معلومة|اشارة|ذكر|تفاصيل|بيانات)`;
const AR_END = String.raw`(?<rest>(?:[\s،,].*)?)$`;

const ARABIC: LanguageRules = {
  lead: rx(
    String.raw`^(?:لكن|ولكن|غير\s+ان|الا\s+ان|مع\s+ذلك|ومع\s+ذلك|للاسف|وللاسف|كما|وكما|وان|ويجدر\s+بالذكر\s+ان|وتجدر\s+الاشارة\s+الى\s+ان|تجدر\s+الاشارة\s+الى\s+ان)\s*[،,]?\s+`,
  ),
  openers: [
    {
      pattern: rx(String.raw`^[وف]?${AR_DOC}\s+${AR_NOT}\s+(?:${AR_ADVERB}\s+)?${AR_DOC_VERBS}${AR_END}`),
      tail: 'any',
    },
    { pattern: rx(String.raw`^[وف]?${AR_NOT}\s+${AR_DOC_VERBS}\s+${AR_DOC}${AR_END}`), tail: 'any' },
    {
      pattern: rx(String.raw`^${AR_PRONOUN}\s*${AR_NOT}\s+(?:${AR_ADVERB}\s+)?${AR_SAY_VERBS}${AR_END}`),
      tail: 'any',
    },
    {
      pattern: rx(
        String.raw`^[وف]?(?:لا|ليس)\s+(?:توجد|يوجد|تتوفر|يتوفر|تتوافر|يتوافر|هناك|ثمة)\s+(?:اي\s+)?${AR_INFO}(?:\s+(?:في|ضمن)\s+${AR_DOC})?${AR_END}`,
      ),
      tail: 'any',
    },
    {
      pattern: rx(
        String.raw`^[وف]?لم\s+(?:ترد|يرد)\s+(?:في\s+${AR_DOC}\s+)?(?:اي\s+)?${AR_INFO}(?:\s+في\s+${AR_DOC})?${AR_END}`,
      ),
      tail: 'any',
    },
    {
      pattern: rx(
        String.raw`^[وف]?لم\s+(?:يذكر|تذكر|يحدد|تحدد|يوضح|توضح|يتم\s+(?:ذكر|تحديد|توضيح|بيان)|تتم\s+الاشارة\s+الى)\s+في\s+${AR_DOC}${AR_END}`,
      ),
      tail: 'wh',
    },
    {
      pattern: rx(String.raw`^[وف]?${AR_NOT}\s+(?:يتضح|يتبين|تتضح)\s+(?:من|في)\s+${AR_DOC}${AR_END}`),
      tail: 'wh',
    },
    {
      pattern: rx(
        String.raw`^[وف]?(?:من\s+)?غير\s+(?:الواضح|المحدد|المذكور|المعروف|المبين)\s+(?:في|من)\s+${AR_DOC}${AR_END}`,
      ),
      tail: 'wh',
    },
    {
      pattern: rx(String.raw`^[وف]?ليس\s+(?:من\s+)?(?:الواضح|واضحا)\s+(?:في|من)\s+${AR_DOC}${AR_END}`),
      tail: 'wh',
    },
  ],
  wh: rx(
    String.raw`^(?:ما\s+اذا|عما\s+اذا|عن\s+ما\s+اذا|اذا\s+ما|اذا\s+(?:كان|كانت|كانوا)|ان\s+(?:كان|كانت|كانوا)|هل|من|متى|اين|كيف|كم|لمن|اي|ماذا|لماذا|عما|ما)(?=\s|$)`,
  ),
  that: rx(String.raw`^(?:ان|بان|انه|انها|انهم|بانه|بانها)(?=\s|$)`),
  about: rx(
    String.raw`^(?:(?:شيئا|شيء|اي\s+شيء|اي\s+معلومات|معلومات|تفاصيل|اي\s+تفاصيل|اشارة)\s+)?(?:عن|حول|بشان|بخصوص|فيما\s+يتعلق\s+ب)\s*`,
  ),
  adverbs: AR_ADVERB,
  commaBefore: rx(String.raw`^\s*(?:ما\s+اذا|هل|ام\s+لا|او\s+لا|اذا\s+(?:كان|كانت))(?=\s|$)`),
  linker: rx(
    String.raw`(?:^|\s)[وف]?(?:لكن|لكنها|لكنه|لذا|لذلك|لان|لانه|لانها|لانهم|بسبب|بل|بينما|حين|رغم|برغم|علما|حيث|اذ|ثم|بالتالي|فان|اذن|لكي|كي|كما)(?=\s|$)`,
  ),
  notInNounPhrase: rx(String.raw`(?:^|\s)(?:[وف][يتن]\S{2,}|التي|الذي|الذين|انه|انها|ان)(?=\s|$)`),
};

// French, Spanish, German -----------------------------------------------------------------------------------------------
const FRENCH: LanguageRules = {
  lead: rx(
    String.raw`^(?:cependant|mais|toutefois|en revanche|néanmoins|neanmoins|par contre|en outre)\s*,?\s+`,
  ),
  openers: [
    {
      pattern: rx(
        String.raw`^(?:(?:le|ce|cet|cette|les|ces)\s+|l')(?:document|texte|pdf|fichier|extrait|extraits|passage|passages|manuscrit|page|pages)(?:\s+(?:téléchargé|telecharge|téléversé|televerse|fourni|transmis|joint))?\s+(?:ne\s+|n')(?:précise|precise|mentionne|indique|dit|donne|spécifie|specifie|explique|détaille|detaille|fournit|contient|aborde|évoque|evoque|précisent|precisent|mentionnent|indiquent|disent|donnent|spécifient|specifient|expliquent|fournissent|contiennent|abordent)\s+(?:pas|nullement|aucunement)(?:\s+(?:explicitement|clairement|précisément|precisement|directement))?${END}`,
      ),
      tail: 'any',
    },
    {
      pattern: rx(
        String.raw`^(?:il|elle|ils|elles)\s+(?:ne\s+|n')(?:précise|precise|mentionne|indique|dit|spécifie|specifie|explique|précisent|precisent|mentionnent|indiquent|disent)\s+pas(?:\s+(?:explicitement|clairement))?${END}`,
      ),
      tail: 'any',
    },
    {
      pattern: rx(
        String.raw`^il\s+n'est\s+pas\s+(?:précisé|precise|mentionné|mentionne|indiqué|indique|dit|spécifié|specifie)(?:\s+dans\s+(?:le|ce)\s+(?:document|texte))?${END}`,
      ),
      tail: 'wh',
    },
    {
      pattern: rx(
        String.raw`^(?:il\s+n'y\s+a|on\s+ne\s+trouve)\s+aucune\s+(?:information|mention|précision|precision|indication)(?:\s+dans\s+(?:le|ce)\s+(?:document|texte))?${END}`,
      ),
      tail: 'any',
    },
  ],
  wh: rx(
    String.raw`^(?:si|s'|qui|quand|où|ou|comment|combien|quel|quelle|quels|quelles|lequel|laquelle|lesquels|lesquelles|ce\s+qui|ce\s+que|pourquoi)(?=\s|$|')`,
  ),
  that: rx(String.raw`^(?:que|qu')`),
  about: rx(
    String.raw`^(?:(?:rien|grand-chose|aucune\s+information|d'informations?)\s+)?(?:sur|concernant|à\s+propos\s+de|a\s+propos\s+de|quant\s+à|quant\s+a)\s+`,
  ),
  adverbs: String.raw`explicitement|clairement|précisément|precisement|directement`,
  commaBefore: rx(String.raw`^\s*(?:si|ou\s+non)\b`),
  linker: rx(
    String.raw`(?:^|\s)(?:mais|donc|car|parce|puisque|alors|ainsi|cependant|toutefois|pourtant|néanmoins|neanmoins|sinon|bien\s+que|tandis)(?=\s|$)`,
  ),
  notInNounPhrase: rx(
    String.raw`(?:^|\s)(?:et|ou|est|sont|était|etait|peut|peuvent|doit|doivent|a|ont|qui|que|dont)(?=\s|$)`,
  ),
};

const SPANISH: LanguageRules = {
  lead: rx(String.raw`^(?:sin\s+embargo|pero|no\s+obstante|además|ademas)\s*,?\s+`),
  openers: [
    {
      pattern: rx(
        String.raw`^(?:el|este|esta|la|los|estos|las|estas)\s+(?:documento|texto|pdf|archivo|fragmento|fragmentos|extracto|extractos|página|pagina|páginas|paginas)(?:\s+(?:subido|cargado|proporcionado|adjunto|facilitado))?\s+no\s+(?:especifica|menciona|indica|dice|aclara|detalla|precisa|explica|incluye|proporciona|contiene|establece|especifican|mencionan|indican|dicen|aclaran|detallan|precisan|explican)(?:\s+(?:explícitamente|explicitamente|claramente|expresamente))?${END}`,
      ),
      tail: 'any',
    },
    {
      pattern: rx(
        String.raw`^no\s+se\s+(?:especifica|menciona|indica|dice|aclara|precisa|detalla)(?:\s+en\s+(?:el|este)\s+(?:documento|texto))?${END}`,
      ),
      tail: 'wh',
    },
    {
      pattern: rx(
        String.raw`^no\s+hay\s+(?:ninguna\s+)?(?:información|informacion|mención|mencion|indicación|indicacion)(?:\s+en\s+(?:el|este)\s+(?:documento|texto))?${END}`,
      ),
      tail: 'any',
    },
  ],
  wh: rx(
    String.raw`^(?:si|quién|quien|quiénes|quienes|cuándo|cuando|dónde|donde|cómo|como|cuánto|cuanto|cuánta|cuanta|cuántos|cuantos|cuántas|cuantas|cuál|cual|cuáles|cuales|qué|para\s+quién|para\s+quien)(?=\s|$)`,
  ),
  that: rx(String.raw`^que(?=\s|$)`),
  about: rx(
    String.raw`^(?:(?:nada|ninguna\s+información|ninguna\s+informacion|información|informacion)\s+)?(?:sobre|acerca\s+de|respecto\s+a|en\s+cuanto\s+a)\s+`,
  ),
  adverbs: String.raw`explícitamente|explicitamente|claramente|expresamente`,
  commaBefore: rx(String.raw`^\s*(?:si|o\s+no)(?=\s|$)`),
  linker: rx(
    String.raw`(?:^|\s)(?:pero|porque|así\s+que|asi\s+que|por\s+lo\s+tanto|sino|aunque|pues|entonces|luego|ya\s+que|mientras)(?=\s|$)`,
  ),
  notInNounPhrase: rx(
    String.raw`(?:^|\s)(?:y|o|es|son|era|eran|puede|pueden|debe|deben|ha|han|que|quien|cual)(?=\s|$)`,
  ),
};

const GERMAN: LanguageRules = {
  lead: rx(String.raw`^(?:jedoch|aber|allerdings|leider)\s*,?\s+`),
  openers: [
    {
      // verb second, "nicht" late: "Das Dokument nennt die Gebühren nicht", "Das Dokument gibt nicht an, ob ..."
      pattern: rx(
        String.raw`^(?:das|dieses|der|die)\s+(?:(?:hochgeladene|bereitgestellte|vorliegende)\s+)?(?:dokument|pdf|text|textauszug|auszug|datei)\s+(?:nennt|erwähnt|erwahnt|gibt|sagt|beschreibt|legt|erklärt|erklart|enthält|enthalt|präzisiert|prazisiert|führt|fuhrt|spezifiziert|macht|klärt|klart)\s+(?<np>(?:[^\s,.;:!?]+\s+){0,6}?)(?:nicht|keine|keinen|keinerlei|nichts)(?:\s+(?:an|fest|aus|genauer|näher|naher|ausdrücklich|ausdrucklich|darüber|daruber|dazu|klar|angaben|informationen))*${END}`,
      ),
      tail: 'any',
    },
  ],
  wh: rx(
    String.raw`^(?:ob|wer|wen|wem|wessen|wann|wo|wie|was|welche|welcher|welches|welchen|warum|weshalb|wieso)(?=\s|$)`,
  ),
  that: rx(String.raw`^(?:dass|daß)(?=\s|$)`),
  about: rx(String.raw`^(?:darüber|daruber|dazu|über|uber|zu)\s+`),
  adverbs: String.raw`ausdrücklich|ausdrucklich|explizit|genau`,
  commaBefore: rx(
    String.raw`^\s*(?:ob|wer|wann|wo|wie|was|welche|welcher|welches|welchen|warum|weshalb|wieso)(?=\s|$)`,
  ),
  linker: rx(
    String.raw`(?:^|\s)(?:aber|denn|weil|deshalb|daher|also|jedoch|sondern|obwohl|trotzdem|dennoch)(?=\s|$)`,
  ),
  notInNounPhrase: rx(
    String.raw`(?:^|\s)(?:und|oder|ist|sind|war|waren|kann|können|konnen|muss|müssen|mussen|hat|haben|dass)(?=\s|$)`,
  ),
};

const RULES: Record<Language, LanguageRules> = {
  en: ENGLISH,
  ar: ARABIC,
  fr: FRENCH,
  es: SPANISH,
  de: GERMAN,
};

// --- the check ------------------------------------------------------------------------------------------------------

export interface SilenceVerdict {
  silence: boolean;
  /** Why it is not one (for tests and logs), or 'silence'. */
  reason: string;
}

const MARKERS = /\[S\d{1,3}\]/gu;
const LEADING_NOISE = /^[\s"'“”«»*_>#`•-]+/u;
const TRAILING_NOISE = /[\s"'“”«»*_.!۔…]+$/u;
const SECOND_SENTENCE = /[.!?؟。]\s*\S|\.\.\.|…/u;
/** Where a second clause, an aside or a quotation starts: ; : — ( ) [ ] " « ». */
const CLAUSE_BREAK = /[;:؛—–()[\]{}"“”«»]|\s-\s/u;
/** "... and they are", "... وهو متوفر": a clause with its own subject joined to a whether-clause. */
const JOINED_CLAUSE =
  /(?:^|\s)(?:(?:and|or|et|ou|y|o|und|oder)\s+(?:they|it|he|she|we|i|ils|elles|il|elle|ellos|ellas|sie|er|es)|[وف](?:هم|هي|هو|هن))(?=\s|$)/u;

const no = (reason: string): SilenceVerdict => ({ silence: false, reason });

/** A tail that names nothing: "so", "it", "this", ذلك, cela ... (the verb's object pronoun is no claim either). */
const PRO_FORM = rx(
  String.raw`^(?:so|this|that|it|them|ذلك|هذا|هذه|لذلك|لهذا|له|لها|ce|cela|ça|ca|eso|esto|das|dies)$`,
);

const orderAtStart = (language: Language): RegExp =>
  new RegExp(`^(?:please\\s+)?(?:${foldText(ORDER_VERBS[language])})(?=\\s|$)`, 'u');
const orderAfterAndOr = (language: Language): RegExp =>
  new RegExp(
    `(?:^|\\s)(?:and|or|و|او|et|ou|y|o|und|oder)\\s+(?:${foldText(ORDER_VERBS[language])})(?=\\s|$)`,
    'u',
  );

/** Rule 1 for the tail of the clause (what follows the verb), then rule 3. */
function judgeTail(
  rest: string,
  kind: TailKind,
  language: Language,
  question: QuestionContext | null | undefined,
): SilenceVerdict {
  const rules = RULES[language];
  if (SECOND_SENTENCE.test(rest)) return no('a second sentence');
  if (CLAUSE_BREAK.test(rest)) return no('a second clause');
  for (const comma of rest.matchAll(/[,،]/gu)) {
    if (!rules.commaBefore.test(rest.slice(comma.index + 1))) return no('a second clause after a comma');
  }
  const leading = new RegExp(`^(?:${foldLetters(rules.adverbs)})(?:\\s+|$)`, 'u');
  const trailing = new RegExp(`(?:^|\\s)(?:${foldLetters(rules.adverbs)})$`, 'u');
  let tail = rest.replace(/[,،]/gu, ' ').replace(/\s+/gu, ' ').trim();
  for (let before = ''; before !== tail;) {
    before = tail;
    tail = tail.replace(leading, '').replace(trailing, '').trim();
  }
  if (tail === '' || PRO_FORM.test(tail)) return { silence: true, reason: 'silence' };
  if (rules.linker.test(tail)) return no('a clause linker');
  if (orderAtStart(language).test(tail)) return no('an order');
  const bare = tail.replace(rules.about, '').trim();
  if (rules.wh.test(bare)) {
    if (orderAfterAndOr(language).test(bare)) return no('an order');
    if (JOINED_CLAUSE.test(bare)) return no('a second clause joined by and/or');
  } else if (rules.that.test(bare)) {
    return no('a "that" clause: a claim, not a silence');
  } else {
    if (kind === 'wh') return no('this form takes only a whether/wh- complement');
    if (rules.notInNounPhrase.test(` ${bare} `)) return no('a clause hidden in the noun phrase');
    if (bare.split(' ').length > MAX_NOUN_PHRASE_WORDS) return no('a noun phrase too long');
  }
  if (!coveredByQuestion(tail, question)) return no('not about the question');
  return { silence: true, reason: 'silence' };
}

/**
 * A code or a shouted word ("PWNED", "hunter2", "X7Q", a number) that is neither the question's nor one of the document's own
 * nouns ("PDF"): what an injected page wants repeated, never what a statement of silence needs.
 */
function foreignCode(text: string, question: QuestionContext | null | undefined): string | null {
  for (const match of text.matchAll(
    /(?<![\p{L}\p{N}])[\p{L}\p{N}]*(?:\p{N}[\p{L}\p{N}]*|\p{Lu}{2,}[\p{L}\p{N}]*)(?![\p{L}\p{N}])/gu,
  )) {
    const token = match[0];
    const shouted = /^\p{Lu}{2,}$/u.test(token.replace(/\p{N}/gu, ''));
    if (!/\p{N}/u.test(token) && !shouted) continue;
    const folded = foldText(token);
    if (FILLER.has(folded) || formsOf(folded).some((form) => question?.forms.has(form) === true)) continue;
    return token;
  }
  return null;
}

/** Whether a sentence is a statement about the document's silence on the question, in the narrow sense above. */
export function silenceVerdict(sentence: string, question?: QuestionContext | null): SilenceVerdict {
  const raw = sentence.replace(MARKERS, ' ').replace(LEADING_NOISE, '').replace(TRAILING_NOISE, '').trim();
  if (raw === '') return no('empty');
  if (/[?؟]$/u.test(raw)) return no('a question');
  if (raw.split(/\s+/u).length > MAX_WORDS) return no('more than 35 words');
  if (foreignCode(raw, question) !== null) return no('a code or a shouted word the question does not have');
  const text = foldText(raw);
  for (const language of Object.keys(RULES) as Language[]) {
    const rules = RULES[language];
    const main = text.replace(rules.lead, '');
    for (const opener of rules.openers) {
      const match = opener.pattern.exec(main);
      if (match === null) continue;
      if (ADDRESS.test(main)) return no('an address or a number');
      if (PERSON_OR_ORDER[language].test(main) || ENGLISH_ORDER.test(main))
        return no('a second person or an order');
      const nounPhrase = (match.groups?.np ?? '').trim();
      if (nounPhrase !== '' && rules.notInNounPhrase.test(` ${nounPhrase} `)) {
        return no('a clause hidden in the noun phrase');
      }
      const rest = `${nounPhrase === '' ? '' : `${nounPhrase} `}${(match.groups?.rest ?? '').trim()}`.trim();
      return judgeTail(rest, opener.tail, language, question);
    }
  }
  return no('no silence template');
}

/** Whether a sentence is a statement about the document's silence (the only uncited sentence an answer may keep). */
export function isSilenceStatement(sentence: string, question?: QuestionContext | null): boolean {
  return silenceVerdict(sentence, question).silence;
}

/**
 * Whether an uncited line may stay as the heading of the cited lines after it (review N3-1): short (at most 8 words), one
 * phrase ending in a colon, nothing in it that no silence statement may hold either (an address, a number, a second person,
 * an order), no second sentence, and no code or shouted word ("PWNED:") that the lines it introduces (`introduced`) do not have.
 */
export function isHarmlessHeading(line: string, introduced = ''): boolean {
  const original = line.replace(LEADING_NOISE, '').replace(/[\s*_`]+$/u, '');
  if (foreignCode(original.replace(/[:：]+$/u, ''), questionContext(introduced)) !== null) return false;
  const text = foldText(original);
  if (!/[:：]$/u.test(text)) return false;
  const body = text.replace(/[:：]+$/u, '').trim();
  if (body === '' || body.split(' ').length > 8) return false;
  if (/[.!?؟;؛:—…]/u.test(body) || ADDRESS.test(body)) return false;
  if (ENGLISH_ORDER.test(body)) return false;
  for (const language of Object.keys(RULES) as Language[]) {
    if (PERSON_OR_ORDER[language].test(body) || orderAtStart(language).test(body)) return false;
  }
  return true;
}
