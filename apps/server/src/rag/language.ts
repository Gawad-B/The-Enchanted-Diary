import { detectLanguage } from '../language/detect.js';

/*
 * The language of a question, as Lab 2 does it and a little further. The share of Arabic letters among the letters decides
 * Arabic (Lab 2's rule, threshold 0.20, digits and punctuation cannot skew it). A Latin-script question is short (a few
 * words), and the server's detector (franc) needs about 40 letters, so function words and diacritics tell French, Spanish,
 * German, Italian, Portuguese, Turkish and English apart first; franc takes the rest. A question that none of them can tell
 * is `und`, never "English": the caller then answers in the language of the document (`resolveAnswerLanguage`) or, with
 * that unknown too, in "the language of the question". The language picks the prompt template, the language of the refusal
 * sentence and which score floor applies.
 */

const ARABIC_LETTER = /\p{Script=Arabic}/u;
const LETTER = /\p{L}/gu;
/** Lab 2's `detect_lang` threshold. */
export const ARABIC_RATIO_THRESHOLD = 0.2;

/** The fraction of the letters of `text` that are Arabic (0..1). */
export function arabicRatio(text: string): number {
  const letters = text.match(LETTER) ?? [];
  if (letters.length === 0) return 0;
  return letters.filter((letter) => ARABIC_LETTER.test(letter)).length / letters.length;
}

// --- Latin-script cues -----------------------------------------------------------------------------------------

interface Cues {
  /** Function words that are (nearly) this language's own, with the accents they are written with, and the points each is worth. */
  words: ReadonlyMap<string, number>;
  /** Letters and signs that belong to it, each worth this many points. */
  characters: ReadonlyMap<string, number>;
}

/** `words`: ordinary function words (1 point each); `strong`: question words and the like that no other language shares (2). */
const cues = (words: string, strong: string, characters: Record<string, number>): Cues => ({
  words: new Map([
    ...words
      .split(/\s+/u)
      .filter((word) => word !== '')
      .map((word): [string, number] => [word, 1]),
    ...strong
      .split(/\s+/u)
      .filter((word) => word !== '')
      .map((word): [string, number] => [word, 2]),
  ]),
  characters: new Map(Object.entries(characters)),
});

const LATIN_CUES: Readonly<Record<string, Cues>> = {
  en: cues(
    `is are was were whom whose does do did of and or not with for in on at by from this that these those there which can could would should will have has had you your it its be been the`,
    `what who where when why how`,
    {},
  ),
  fr: cues(
    `le la les des du une est sont dans pour avec sur et ou ne pas plus très aussi cette ces ses mes l'on se était étaient été fondé y il elle ils elles nous vous je tu`,
    `qui quoi où quand comment pourquoi quel quelle quels quelles est-ce qu'est-ce c'est trouve`,
    { ç: 2, œ: 2, ù: 2, â: 1, ê: 1, î: 1, ô: 1, û: 1, è: 1, à: 1, ï: 1 },
  ),
  es: cues(
    `el los las una unos unas es son por porque para con sobre y o pero también más está están fue fueron esta este estos estas del al su sus mi mis usted ustedes nosotros se lo le les`,
    `qué quién quiénes cuál cuáles cuándo dónde cómo`,
    { ñ: 3, '¿': 3, '¡': 3, á: 1, í: 1, ó: 1, ú: 1 },
  ),
  de: cues(
    `der die das den dem des ein eine einen einem einer eines ist sind war waren und oder mit für von zu im am auf aus bei nach über unter durch gegen ohne auch nur sehr noch schon hat haben wurde wurden was`,
    `wer wo wann wie warum welche welcher welches nicht`,
    { ß: 3, ä: 1, ö: 1, ü: 1 },
  ),
  it: cues(
    `il lo gli le un uno una di del dello della dei degli delle è sono era erano che su tra fra e o ma anche più molto questo questa questi queste quello quella come per con non`,
    `chi cosa dove quando perché`,
    { ò: 1, ì: 1, ù: 1, è: 1 },
  ),
  pt: cues(
    `o os as um uma uns umas de do da dos das em no na nos nas para com sem entre sobre e ou mas é são era eram que qual quais mais muito também só foi há tinha este esta estes estas esse essa`,
    `quem onde quando como porquê porque não`,
    { ã: 2, õ: 2, ç: 1, ê: 1, â: 1 },
  ),
  tr: cues(
    `ve veya ama ise de da ki bir bu şu o için ile gibi kadar daha çok en mi mı mu mü hem hiç her olan olarak var yok değil`,
    `ne nasıl neden nerede kim hangi kaç`,
    { ı: 3, ş: 3, ğ: 3, ç: 1 },
  ),
};

const WORD = /[\p{L}'’-]+/gu;

/**
 * Points a language earns from a question's function words and characters. A single accented letter that two or three
 * languages share is worth one point and counts once; the letters only one language has (ß, ñ, ı, ş, ğ, ã, ¿) count twice.
 */
function cueScore(language: Cues, words: readonly string[], text: string): number {
  let score = 0;
  for (const word of words) score += language.words.get(word) ?? 0;
  let weak = 0;
  let strong = 0;
  for (const character of text) {
    const points = language.characters.get(character);
    if (points === undefined) continue;
    if (points >= 2 && strong < 2) {
      score += points;
      strong += 1;
    } else if (points < 2 && weak < 1) {
      score += points;
      weak += 1;
    }
  }
  return score;
}

/**
 * The Latin-script language the cues point at, or null when they do not decide: the best language needs at least two
 * points and a lead of at least one over the next. Elided forms ("qu'est-ce", "l'université") are tried whole and by
 * the part after the apostrophe.
 */
function cueLanguage(question: string): string | null {
  const text = question.normalize('NFC').toLowerCase();
  const words = (text.match(WORD) ?? []).flatMap((word) => {
    const clean = word.replace(/^[-'’]+|[-'’]+$/gu, '');
    const parts = clean.split(/['’]/u).filter((part) => part !== '');
    return parts.length > 1 ? [clean, ...parts] : [clean];
  });
  const scores = Object.entries(LATIN_CUES)
    .map(([code, entry]) => ({ code, score: cueScore(entry, words, text) }))
    .sort((a, b) => b.score - a.score);
  const [best, second] = scores;
  if (best === undefined || best.score < 2) return null;
  return best.score - (second?.score ?? 0) >= 1 ? best.code : null;
}

/**
 * The language code of a question: `ar` by Lab 2's ratio rule (`fa` / `ur` when the Arabic script says so), else the
 * Latin-script cues, else the detector's guess, else `und` (never a silent English).
 */
export function detectQuestionLanguage(question: string): string {
  if (arabicRatio(question) >= ARABIC_RATIO_THRESHOLD) {
    const guess = detectLanguage(question).code;
    return guess === 'fa' || guess === 'ur' ? guess : 'ar';
  }
  const cued = cueLanguage(question);
  if (cued !== null) return cued;
  return detectLanguage(question).code;
}

/**
 * The language to answer, and refuse, in: the question's when it is known, else the document's, else `und` (the prompt then
 * says "in the language of the question").
 */
export function resolveAnswerLanguage(questionLanguage: string, documentLanguage: string): string {
  if (questionLanguage !== 'und' && questionLanguage !== '') return questionLanguage;
  return documentLanguage === '' ? 'und' : documentLanguage;
}

/** The language's English name for a prompt ("ar" gives "Arabic"), or null when it is unknown. */
export function languageName(code: string): string | null {
  if (code === '' || code === 'und') return null;
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code);
    return name === undefined || name === code ? null : name;
  } catch {
    return null;
  }
}

/**
 * Whether a question is written in the language of the document it is asked of (Lab 2's `lang == DOC_LANG`): true, false, or
 * null when either language is unknown (the evidence gate then applies the lower of its two floors).
 */
export function isSameLanguage(question: string, documentLanguage: string): boolean | null {
  if (documentLanguage === '' || documentLanguage === 'und') return null;
  const asked = detectQuestionLanguage(question);
  return asked === 'und' ? null : asked === documentLanguage;
}
