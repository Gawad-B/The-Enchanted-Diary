import { normalizeForMatch } from '@enchanted/shared';
import { SENTINEL_CORE } from './sentinel.js';

/*
 * Prompt-injection defences for text that comes out of an uploaded PDF. The rule behind all of it: document text is
 * DATA. It reaches the model only inside an `<excerpt>` element of the USER turn, after four things have happened to it:
 *
 *   1. sanitizeExcerptText: invisible and default-ignorable characters are removed (a zero-width joiner inside a tag name
 *      must not hide it), EVERY angle bracket is escaped (`<` and `>`, and their look-alikes, become `&lt;` and `&gt;`), so a
 *      page can never close the excerpt block, open a fake one, or write a chat role tag: there is no deny-list of tag names to
 *      get past. Lines that look like OUR prompt lines ("Retrieval confidence: strong", "Question:", "Reminder:"), role labels,
 *      chat-template tokens, the refusal sentinel and citation markers are rewritten into forms that nothing of ours reads;
 *   2. flagInstructionLike: text that tries to give orders is marked `flagged="instruction-like"`, which the system
 *      prompt tells the model to quote or describe, never follow;
 *   3. attribute values (file name, section title) are escaped, so they cannot leave their attribute;
 *   4. the prompt restates the untrusted-content rule AFTER the excerpts (prompts.ts), where it is the last thing read.
 *
 * These are defences in depth, not a proof: a model can still be persuaded. The output guard (guard.ts), the dropping of
 * uncited text (reply.ts) and the evals measure what is left.
 */

// --- Sanitising ---------------------------------------------------------------------------------------------

/**
 * Characters that are invisible or steer rendering, the Unicode "default ignorable" ones included: tag characters and
 * variation selectors (used to smuggle hidden instructions), bidi controls and marks, zero-width space, the invisible
 * operators (U+2061-2064), word joiner, BOM, soft hyphen, the combining grapheme joiner, Hangul and Khmer fillers,
 * the Mongolian selectors, and C0 / C1 control characters except tab and line feed. ZWNJ / ZWJ (U+200C / U+200D) are
 * handled by {@link stripJoiners}: they stay only where a script needs them.
 */
const INVISIBLE = new RegExp(
  // listed one by one on purpose: some are combining or joining characters, which is why they are stripped
  // eslint-disable-next-line no-misleading-character-class
  [
    String.raw`[\u{E0000}-\u{E0FFF}]`,
    String.raw`[\u{202A}-\u{202E}\u{200E}\u{200F}\u{061C}]`,
    String.raw`[\u{200B}\u{2060}-\u{206F}\u{FEFF}\u{00AD}\u{034F}\u{115F}\u{1160}\u{17B4}\u{17B5}\u{180B}-\u{180F}\u{3164}\u{FE00}-\u{FE0F}\u{FFA0}]`,
    String.raw`[\u{1BCA0}-\u{1BCA3}\u{1D173}-\u{1D17A}]`,
    String.raw`[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]`,
  ].join('|'),
  'gu',
);

const JOINERS = /[\u200C\u200D]/gu;
/** Letters of the scripts that cannot be written correctly without ZWNJ / ZWJ (Persian, Urdu, the Indic and Khmer scripts). */
const NEEDS_JOINER =
  /[\p{Script=Arabic}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/** Removes ZWNJ / ZWJ except between two letters of a script that needs them (everywhere else they only hide words). */
function stripJoiners(text: string): string {
  return text.replace(JOINERS, (joiner, offset: number, whole: string) => {
    const before = whole[offset - 1] ?? '';
    const after = whole[offset + 1] ?? '';
    return NEEDS_JOINER.test(before) && NEEDS_JOINER.test(after) ? joiner : '';
  });
}

/** Text without invisible characters: what a reader sees, and what the matchers and the model should see. */
export function stripInvisible(text: string): string {
  return stripJoiners(text.replace(INVISIBLE, ''));
}

/**
 * What counts as an angle bracket: the ASCII ones, whatever NFKC folds into them (the fullwidth and small forms U+FF1C, U+FE64 ...,
 * and the legacy U+2329 / U+232A, which fold into U+3008 / U+3009), and the characters the Unicode character database NAMES as
 * angle brackets, angle quotation marks, less-than / greater-than signs or left / right arrowhead letters: the modifier letters
 * U+02C2 / U+02C3 and U+02F1 / U+02F2, the Canadian syllabics U+1438 / U+1433, the ornamental, mathematical and curved angle
 * brackets, the CJK ones. The double angle quotation marks « » (U+00AB, U+00BB) stay: they are the quotation marks of French,
 * Spanish, Russian and Arabic text, and rewriting every quotation in those documents would be worse than the look-alike.
 */
const ANGLE_OPEN =
  /[<\u02C2\u02F1\u1438\u2039\u276C\u276E\u2770\u27E8\u27EA\u29FC\u3008\u300A\uFE3D\uFE3F]/gu;
const ANGLE_CLOSE =
  /[>\u02C3\u02F2\u1433\u203A\u276D\u276F\u2771\u27E9\u27EB\u29FD\u3009\u300B\uFE3E\uFE40]/gu;
const ROLE_LABEL = /^([ \t]*)(system|assistant|developer|human|user)([ \t]*):/gimu;
const MARKDOWN_ROLE_HEADING = /^([ \t]*)#{1,6}([ \t]*(?:system|instructions?|assistant)\b)/gimu;
/** Lines of OUR prompt, in either language: a document line that starts like one is made harmless by its colon. */
const PROMPT_LINE =
  /^([ \t]*(?:[*_#>-]+[ \t]*)?)(retrieval\s+confidence|question|answer\s+in\s+[^\n:\u{FF1A}]{1,40}|reminder|\u{062B}\u{0642}\u{0629}\s+\u{0627}\u{0644}\u{0627}\u{0633}\u{062A}\u{0631}\u{062C}\u{0627}\u{0639}|\u{0627}\u{0644}\u{0633}\u{0624}\u{0627}\u{0644}|\u{0627}\u{0644}\u{0625}\u{062C}\u{0627}\u{0628}\u{0629}\s+\u{0628}\u{0627}\u{0644}\u{0639}\u{0631}\u{0628}\u{064A}\u{0629}|\u{062A}\u{0630}\u{0643}\u{064A}\u{0631})([ \t]*):/gimu;
const INST_MARKERS = /\[\s*\/?\s*inst\s*\]/giu;
// The refusal sentinel (NOT_IN_DOCUMENT) in the document's text could be copied into an answer and make it a refusal.
// (as wide as the detector in sentinel.ts: the bracketed and underscore spellings anywhere, and the plain words "not found" / "not in
// document" at the start of a line, which is where an answer that quotes the line would begin)
const SENTINEL_LIKE = new RegExp(
  String.raw`[\[(]{1,2}\s*${SENTINEL_CORE}\s*[\])]{1,2}|\bnot_(?:in_document|found)\b|^([ \t]*(?:[*_>#\u0060"'“”-]+[ \t]*)?)${SENTINEL_CORE}(?![\p{L}\p{N}_])`,
  'gimu',
);
const MARKER_LIKE = /\[\s*S\s*\d{1,3}(?:\s*[,;]\s*S?\s*\d{1,3})*\s*\]/giu;

/** The sentinel in a document's text, rewritten into a form nothing of ours reads (a line's own indent and quote marks stay). */
const neutraliseSentinel = (match: string, lead: string | undefined): string =>
  `${lead ?? ''}\u{27E6}NOT-IN-DOCUMENT\u{27E7}`;

const toFullwidthBrackets = (marker: string): string =>
  marker.replaceAll('[', '\u{FF3B}').replaceAll(']', '\u{FF3D}');

/**
 * Makes text safe to place inside an excerpt: nothing in it can pass for our delimiters, prompt lines, roles, sentinel or
 * markers. Every `<` and `>` (and look-alike) is escaped to an entity, which the model reads as the escaped character it is.
 */
export function sanitizeExcerptText(text: string): string {
  return stripInvisible(text)
    .normalize('NFKC')
    .replace(ANGLE_OPEN, '&lt;')
    .replace(ANGLE_CLOSE, '&gt;')
    .replace(ROLE_LABEL, '$1$2$3\u{FF1A}')
    .replace(PROMPT_LINE, '$1$2$3\u{FF1A}')
    .replace(MARKDOWN_ROLE_HEADING, '$1\u{FF03}$2')
    .replace(INST_MARKERS, toFullwidthBrackets)
    .replace(SENTINEL_LIKE, neutraliseSentinel)
    .replace(MARKER_LIKE, toFullwidthBrackets);
}

/** The sentinel and the citation markers made harmless, for the values of attributes (a section title is document text too). */
const neutraliseNames = (text: string): string =>
  text.replace(SENTINEL_LIKE, neutraliseSentinel).replace(MARKER_LIKE, toFullwidthBrackets);

/** A piece of a document for a reader (a citation snippet, a section title): invisible characters out, nothing else changed. */
export const displayText = (text: string): string => stripInvisible(text).replace(/\s+/gu, ' ').trim();

const ATTRIBUTE_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** A value for an XML-style attribute: control characters and line breaks become spaces, markup characters are escaped. */
export function escapeAttribute(value: string, maxChars = 120): string {
  // an attribute value is document text too (a section title): the sentinel and the citation markers are made as harmless in it
  const flat = neutraliseNames(stripInvisible(value).normalize('NFKC')).replace(/\s+/gu, ' ').trim();
  const cut = Array.from(flat).slice(0, maxChars).join('');
  return cut.replace(/[&<>"']/gu, (character) => ATTRIBUTE_ESCAPES[character] ?? character);
}

// --- Flagging -----------------------------------------------------------------------------------------------

/** Cyrillic and Greek letters that look like Latin ones: folded so "Ignore" written with a Cyrillic o is still "ignore". */
const CONFUSABLES: Record<string, string> = {
  '\u{0430}': 'a',
  '\u{0435}': 'e',
  '\u{043E}': 'o',
  '\u{0440}': 'p',
  '\u{0441}': 'c',
  '\u{0445}': 'x',
  '\u{0443}': 'y',
  '\u{0456}': 'i',
  '\u{0458}': 'j',
  '\u{0455}': 's',
  '\u{03BF}': 'o',
  '\u{03B1}': 'a',
  '\u{03B5}': 'e',
  '\u{03B9}': 'i',
  '\u{03BD}': 'v',
  '\u{03C1}': 'p',
};

/** Text reduced for matching: NFKC, marks and diacritics removed, lower case, look-alikes folded, punctuation gone. */
function fold(text: string): string {
  const stripped = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(INVISIBLE, '')
    .replace(JOINERS, '')
    .replace(
      /[\u{0400}-\u{04FF}\u{0370}-\u{03FF}]/gu,
      (letter) => CONFUSABLES[letter.toLowerCase()] ?? letter,
    );
  return normalizeForMatch(stripped);
}

/** A rule on folded text (words separated by single spaces): the pattern must start and end on word edges. */
const rule = (id: string, pattern: string): { id: string; test: RegExp } => ({
  id,
  test: new RegExp(`(?:^|\\s)(?:${pattern})(?=\\s|$)`, 'u'),
});

/** Up to three words between a verb and its object ("ignore ALL of the PREVIOUS instructions"). */
const GAP = String.raw`(?:\S+\s+){0,3}?`;

const WORD_RULES = [
  // English
  rule(
    'en-ignore-instructions',
    String.raw`(?:ignore|disregard|forget|override|bypass|skip|neglect)\s+${GAP}(?:instructions?|prompts?|rules|directions?|guidelines|constraints|directives)`,
  ),
  rule(
    'en-system-prompt',
    String.raw`(?:system|developer|hidden|initial|original)\s+(?:prompt|message|instructions?)`,
  ),
  rule('en-you-are-now', String.raw`you\s+are\s+(?:now|no\s+longer)`),
  rule('en-act-as', String.raw`act\s+as`),
  rule('en-pretend', String.raw`pretend\s+(?:to\s+be|you\s+are|that\s+you)`),
  rule('en-mode', String.raw`(?:developer|debug|dan|jailbreak|god|admin|sudo|unrestricted)\s+mode`),
  rule(
    'en-reveal',
    String.raw`(?:reveal|show|print|output|repeat|display|leak|tell\s+me)\s+(?:me\s+)?(?:your|the)\s+(?:system|hidden|secret|initial|original|instructions?|prompt)`,
  ),
  rule('en-from-now-on', String.raw`from\s+now\s+on`),
  rule('en-reply-only', String.raw`(?:reply|respond|answer|output)\s+(?:only|exclusively)\s+with`),
  rule('en-new-instructions', String.raw`new\s+instructions?`),
  rule('en-hide-from-user', String.raw`do\s+not\s+(?:tell|mention|reveal|inform)\s+(?:the\s+)?user`),
  // Arabic (the text is folded: alef forms unified, taa marbuta as haa, alef maqsura as yaa, marks removed)
  rule(
    'ar-ignore-instructions',
    String.raw`(?:تجاهل|تجاهلي|اهمل|انس|انسي|تخط|تخطي|تجاوز)\s+${GAP}(?:التعليمات|الاوامر|القواعد|التوجيهات|الارشادات|التعليمات\S*)`,
  ),
  rule('ar-system-prompt', String.raw`(?:تعليمات|موجه|رسالة|رساله|امر|اوامر)\s+(?:النظام|المطور)`),
  rule('ar-you-are-now', String.raw`انت\s+الان`),
  rule('ar-mode', String.raw`وضع\s+(?:المطور|التصحيح|المبرمج)`),
  rule('ar-reply-only', String.raw`(?:اجب|رد|اكتب|قل)\s+(?:فقط|حصريا)\s+\S*`),
  rule('ar-reveal', String.raw`(?:اكشف|اظهر|اعرض|اطبع|كرر)\s+(?:لي\s+)?${GAP}(?:النظام|التعليمات|الموجه)`),
  rule('ar-act-as', String.raw`تصرف\s+(?:كانك|كما\s+لو|ك\S+)`),
  rule('ar-from-now-on', String.raw`من\s+الان\s+فصاعدا`),
  // French
  rule(
    'fr-ignore-instructions',
    String.raw`(?:ignore[zr]?|oublie[zr]?|neglige[zr]?)\s+${GAP}(?:instructions?|consignes?|regles?|directives?)`,
  ),
  rule(
    'fr-system-prompt',
    String.raw`(?:prompt|invite|message|instructions?)\s+(?:du\s+)?(?:systeme|developpeur)`,
  ),
  rule('fr-you-are-now', String.raw`(?:tu\s+es|vous\s+etes)\s+(?:maintenant|desormais)`),
  rule('fr-mode', String.raw`mode\s+developpeur`),
  rule('fr-reply-only', String.raw`(?:reponds?|repondez)\s+(?:uniquement|seulement)\s+(?:par|avec)`),
  rule('fr-reveal', String.raw`(?:revele[zr]?|affiche[zr]?|montre[zr]?)\s+${GAP}(?:instructions|prompt)`),
  rule('fr-from-now-on', String.raw`a\s+partir\s+de\s+maintenant`),
  // Spanish
  rule(
    'es-ignore-instructions',
    String.raw`(?:ignora|ignore|ignorar|olvida|olvide|omite)\s+${GAP}(?:instrucciones|reglas|indicaciones|directrices)`,
  ),
  rule(
    'es-system-prompt',
    String.raw`(?:prompt|mensaje|instrucciones)\s+(?:del\s+)?(?:sistema|desarrollador)`,
  ),
  rule('es-you-are-now', String.raw`(?:ahora\s+eres|eres\s+ahora|ahora\s+actuas)`),
  rule('es-mode', String.raw`modo\s+(?:desarrollador|programador)`),
  rule('es-reply-only', String.raw`responde\s+(?:solo|unicamente|solamente)\s+con`),
  rule('es-reveal', String.raw`(?:revela|muestra|imprime)\s+${GAP}(?:instrucciones|prompt)`),
  rule('es-from-now-on', String.raw`a\s+partir\s+de\s+ahora`),
  // German
  rule(
    'de-ignore-instructions',
    String.raw`(?:ignoriere|ignorieren|vergiss|missachte|ubergehe|uberspringe)\s+${GAP}(?:anweisungen|instruktionen|regeln|vorgaben|befehle)`,
  ),
  rule('de-system-prompt', String.raw`(?:system\s?prompt|systemnachricht|entwicklernachricht)`),
  rule('de-you-are-now', String.raw`(?:du\s+bist|sie\s+sind)\s+(?:jetzt|nun|ab\s+sofort)`),
  rule('de-mode', String.raw`entwicklermodus`),
  rule('de-reply-only', String.raw`(?:antworte|antworten\s+sie)\s+nur\s+mit`),
  rule('de-reveal', String.raw`(?:verrate|enthulle|zeige)\s+${GAP}(?:anweisungen|prompt|systemprompt)`),
  rule('de-from-now-on', String.raw`ab\s+jetzt`),
] as const;

/** Markers that only make sense as a command to a model, whatever the language (checked on the raw text). */
const RAW_RULES = [
  { id: 'chat-template-token', test: /<\|[a-z_]+\|>|<\|im_(?:start|end)\|>/iu },
  { id: 'llama-marker', test: /\[\s*\/?\s*inst\s*\]|<<\s*\/?\s*sys\s*>>/iu },
  { id: 'markdown-role-heading', test: /^[ \t]*#{1,6}[ \t]*(?:system|instructions?)\b/imu },
] as const;

/** The ids of every rule that fires on `text` (empty when it reads as ordinary prose). */
export function instructionSignals(text: string): string[] {
  const raw = text.replace(INVISIBLE, '').replace(JOINERS, '');
  const folded = fold(text);
  return [
    ...RAW_RULES.filter((entry) => entry.test.test(raw)).map((entry) => entry.id),
    ...WORD_RULES.filter((entry) => entry.test.test(folded)).map((entry) => entry.id),
  ];
}

/**
 * Whether text looks like it tries to give orders to an AI: "ignore all previous instructions", "you are now ...",
 * "system prompt", "act as", "developer mode", "reveal ...", chat-template tokens, in English, Arabic, French, Spanish
 * and German. Heuristic and deliberately a little trigger-happy: a flagged excerpt is still shown to the model (it
 * may be what the question is about), only labelled; and a miss still meets the other defences.
 */
export function flagInstructionLike(text: string): boolean {
  return instructionSignals(text).length > 0;
}

// --- Formatting ---------------------------------------------------------------------------------------------

export interface ExcerptView {
  /** `S1`, `S2`, ...: valid for this turn only. */
  id: string;
  pageStart: number;
  pageEnd: number;
  sectionTitle: string | null;
  language: string;
  /** Already sanitised text. */
  text: string;
  flagged: boolean;
}

const pageLabel = (excerpt: ExcerptView): string =>
  excerpt.pageEnd > excerpt.pageStart
    ? `${String(excerpt.pageStart)}-${String(excerpt.pageEnd)}`
    : String(excerpt.pageStart);

/**
 * `<document_excerpts>` with one `<excerpt id="S1" page="12" section="..." lang="en" flagged="instruction-like">` per
 * excerpt. The file name and the section titles appear only here, as escaped attribute values.
 */
export function formatExcerpts(excerpts: readonly ExcerptView[], documentName: string): string {
  const items = excerpts.map((excerpt) => {
    const attributes = [
      `id="${excerpt.id}"`,
      `page="${pageLabel(excerpt)}"`,
      ...(excerpt.sectionTitle === null ? [] : [`section="${escapeAttribute(excerpt.sectionTitle)}"`]),
      `lang="${escapeAttribute(excerpt.language, 12)}"`,
      ...(excerpt.flagged ? ['flagged="instruction-like"'] : []),
    ];
    return `<excerpt ${attributes.join(' ')}>\n${excerpt.text}\n</excerpt>`;
  });
  return `<document_excerpts document="${escapeAttribute(documentName)}">\n${items.join('\n')}\n</document_excerpts>`;
}
