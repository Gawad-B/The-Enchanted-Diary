/*
 * A cheap, deliberately conservative token estimate for multilingual embedding models (sentencepiece vocabularies). It
 * runs in the ingestion worker and only has to keep chunks well inside the model's input window (gemini-embedding-2 takes
 * 8,192 tokens, and a chunk is about 2,000 characters). A provider that can count exactly (`countTokensSync`) is asked on
 * the main thread, and every chunk that is still too long is split again there (see `enforceTokenWindow` in chunker.ts),
 * so an estimate that is too low costs a second split, never a truncated chunk.
 *
 * The weights are tokens per character, measured once with an XLM-RoBERTa sentencepiece tokenizer on 1,000-character
 * samples and rounded up (a safe upper bound for the vocabularies in use):
 *   Latin prose 0.24, Hindi/Thai/Georgian/Tamil 0.19-0.25, Arabic prose 0.24, ASCII digits 0.31, Han/Kana 0.5-0.6,
 *   Arabic-Indic digits 0.5-0.76 (about one token per digit), ASCII punctuation and symbols 1.0, mathematical and box
 *   symbols 0.5-0.9, emoji 0.88 per code point.
 * Letters (and ASCII digits) are counted per run, with at least one token for every run: "x", "dx" and "MS" in a
 * formula or a part number are a token each however few letters they have, which a per-letter weight would round away
 * (a text of one-letter words costs 0.5 tokens per character). A space in front of a symbol is a token of its own.
 */
const LETTER_WEIGHT = 0.34;
const ARABIC_WEIGHT = 0.42;
const CJK_WEIGHT = 0.85;
const ASCII_DIGIT_WEIGHT = 0.55;
const SPACE_WEIGHT = 0.1;
/** One token for every symbol, punctuation mark, mark and non-ASCII digit: the worst case for sentencepiece. */
const SYMBOL_WEIGHT = 1;
/** An astral code point (emoji) can cost more than one token. */
const ASTRAL_WEIGHT = 1.5;
/** A word, however short, is at least one token ("x", "dx", "e" in a formula, "MS"): letters count per run, not per letter. */
const MIN_RUN_TOKENS = 1;
/** A space in front of a symbol cannot be absorbed into the symbol's token: sentencepiece writes it as a token of its own. */
const SPACE_BEFORE_SYMBOL_WEIGHT = 1;

/** Tokens that surround every input (start and end markers) plus the "passage: " prefix, with a little slack. */
export const EMBEDDING_INPUT_OVERHEAD_TOKENS = 12;

/** Combining marks (Devanagari vowel signs, Arabic diacritics) belong to the word they sit in. */
const LETTER = /[\p{L}\p{M}]/u;
const SPACE = /\s/u;

type Kind = 'latin' | 'arabic' | 'digit' | 'space' | 'cjk' | 'astral' | 'arabicDigit' | 'symbol';

function kindOf(char: string): Kind {
  const code = char.codePointAt(0) ?? 0;
  if (code < 0x80) {
    if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) return 'latin';
    if (code >= 0x30 && code <= 0x39) return 'digit';
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) return 'space';
    return 'symbol';
  }
  if (code > 0xffff) return code >= 0x20000 && code <= 0x2fa1f ? 'cjk' : 'astral';
  if (
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff)
  ) {
    return 'cjk';
  }
  if ((code >= 0x660 && code <= 0x669) || (code >= 0x6f0 && code <= 0x6f9)) return 'arabicDigit';
  if (code >= 0x600 && code <= 0x6ff && LETTER.test(char)) return 'arabic';
  if ((code >= 0x750 && code <= 0x77f) || (code >= 0xfb50 && code <= 0xfeff)) return 'arabic';
  if (LETTER.test(char)) return 'latin';
  if (SPACE.test(char)) return 'space';
  return 'symbol';
}

export function estimateTokens(text: string): number {
  let total = 0;
  // The run of letters (or ASCII digits) being read: its kind and its cost so far.
  let run: 'latin' | 'arabic' | 'digit' | null = null;
  let runCost = 0;
  let spaceBefore = false;
  const endRun = (): void => {
    if (run !== null) total += Math.max(MIN_RUN_TOKENS, runCost);
    run = null;
    runCost = 0;
  };
  for (const char of text) {
    const kind = kindOf(char);
    if (kind === 'latin' || kind === 'arabic' || kind === 'digit') {
      if (run !== kind) endRun();
      run = kind;
      runCost += kind === 'latin' ? LETTER_WEIGHT : kind === 'arabic' ? ARABIC_WEIGHT : ASCII_DIGIT_WEIGHT;
      spaceBefore = false;
      continue;
    }
    endRun();
    switch (kind) {
      case 'space':
        total += SPACE_WEIGHT;
        spaceBefore = true;
        continue;
      case 'cjk':
        total += CJK_WEIGHT;
        break;
      case 'astral':
        total += ASTRAL_WEIGHT;
        break;
      default:
        total += SYMBOL_WEIGHT; // symbols, punctuation, marks, Arabic-Indic digits: about one token each
        if (spaceBefore && kind === 'symbol') total += SPACE_BEFORE_SYMBOL_WEIGHT - SPACE_WEIGHT;
        break;
    }
    spaceBefore = false;
  }
  endRun();
  return Math.ceil(total);
}
