import type { GuardVerdict, OutputGuard } from './guard.js';
import { isRefusalReply, scanReply } from './sentinel.js';
import { isHarmlessHeading, isSilenceStatement, type QuestionContext } from './silence.js';

/*
 * Handling of the model's reply while it streams, and after it has finished.
 *
 * While streaming (ReplyProcessor):
 *  1. the first characters are held back until they can no longer be the refusal sentinel, and, until the reply has cited
 *     something, the start of each sentence is held back while it can still become the mandated "the uploaded document does
 *     not provide enough information" (see sentinel.ts: ONE detector, `scanReply`, for the stream and the finished text); a
 *     leading refusal is never streamed, and the model is stopped;
 *  2. excerpt markers are normalised and checked as they complete: `[S3]` passes when S3 is an excerpt of this turn, an invented
 *     `[S9]` is dropped (a marker split across two chunks is held until it completes). Variants are read as markers too:
 *     `[s3]`, `[S03]`, `(S3)`, `【S3】`, `[S1-S3]`, `[S١]` (Arabic-Indic digits);
 *  3. the output guard looks at everything the model has written so far.
 * When the stream is over (`finalizeReply`) the same rules are applied to the whole text, with the ones a stream cannot
 * apply: grouped markers `[S1, S2]` are expanded, spacing is tidied, and every sentence that cites nothing is dropped unless
 * it is a statement of the document's silence on the visitor's question (silence.ts; a page that talks the model into
 * writing "Audit: ..." or "Notice: ..." gets no uncited line into an answer). That final text is authoritative: it is what
 * `done.answer` carries and what is stored.
 */

const DIGITS = '[0-9\\u0660-\\u0669\\u06F0-\\u06F9]{1,3}';
/** One marker group in any of its spellings: `[S1]`, `[s 1]`, `(S1)`, `【S1】`, `[S1, S3]`, `[S1-S3]`, `[S01]`. */
const MARKER_GROUP = new RegExp(
  `[\\[\\u3010(]\\s*[Ss]\\s*(${DIGITS})((?:\\s*(?:[-\\u2013\\u2014]\\s*[Ss]?\\s*${DIGITS}|[,;\\u060C]\\s*[Ss]?\\s*${DIGITS}))*)\\s*[\\]\\u3011)]`,
  'gu',
);
const MARKER_NUMBER = new RegExp(DIGITS, 'gu');
/** The tail of a text that may still become a marker: an opener, then at most `S`, digits, separators. */
const MARKER_TAIL = new RegExp(
  `[\\[\\u3010(]\\s*[Ss]?\\s*[0-9\\u0660-\\u0669\\u06F0-\\u06F9\\s,;\\u060C\\u2013\\u2014Ss-]*$`,
  'u',
);
const MAX_RANGE = 12;

const toAscii = (digits: string): number =>
  Number(
    digits.replace(/[٠-٩۰-۹]/gu, (digit) => {
      const code = digit.charCodeAt(0);
      return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
    }),
  );

/** Every marker group of the text written as plain `[S1][S2]` markers (ranges and lists expanded, digits ASCII). */
export function normalizeMarkers(text: string): string {
  return text.replace(MARKER_GROUP, (_group, first: string, rest: string) => {
    const numbers: number[] = [toAscii(first)];
    const separators =
      rest.match(/([-–—])\s*[Ss]?\s*([0-9٠-٩۰-۹]{1,3})|[,;،]\s*[Ss]?\s*([0-9٠-٩۰-۹]{1,3})/gu) ?? [];
    for (const part of separators) {
      const isRange = /^[-–—]/u.test(part);
      const value = toAscii(part.match(MARKER_NUMBER)?.[0] ?? '0');
      const previous = numbers.at(-1) ?? value;
      if (isRange && value > previous && value - previous <= MAX_RANGE) {
        for (let n = previous + 1; n <= value; n += 1) numbers.push(n);
      } else if (!numbers.includes(value)) {
        numbers.push(value);
      }
    }
    return numbers.map((n) => `[S${String(n)}]`).join('');
  });
}

/** Normalises the markers of a piece of text and drops the ones that name no excerpt of this turn. */
function filterMarkers(text: string, valid: ReadonlySet<string>): string {
  return normalizeMarkers(text).replace(/\[S(\d{1,3})\]/gu, (marker, digits: string) =>
    valid.has(`S${digits}`) ? marker : '',
  );
}

/** Drops markers that do not name an excerpt of this turn, as text arrives in arbitrary pieces. */
class MarkerFilter {
  private held = '';

  constructor(private readonly valid: ReadonlySet<string>) {}

  push(text: string): string {
    const input = this.held + text;
    const tail = MARKER_TAIL.exec(input);
    const cut = tail === null ? input.length : tail.index;
    this.held = input.slice(cut);
    return filterMarkers(input.slice(0, cut), this.valid);
  }

  flush(): string {
    const rest = this.held;
    this.held = '';
    return rest;
  }
}

export interface PushResult {
  /** Text to send to the client now. */
  emit: string;
  /** Set when the output guard stopped the reply: the caller must abort the model and replace the reply. */
  blocked: GuardVerdict | null;
}

export class ReplyProcessor {
  private raw = '';
  /** How much of `raw` has gone to the marker filter. */
  private released = 0;
  /** `sentinel`: the start may still be the sentinel; `scan`: sentence starts are watched; `settled`: nothing is held. */
  private phase: 'sentinel' | 'scan' | 'settled' = 'sentinel';
  private refused = false;
  private blockedVerdict: GuardVerdict | null = null;
  private readonly filter: MarkerFilter;

  constructor(
    validMarkers: ReadonlySet<string>,
    private readonly guard: OutputGuard,
  ) {
    this.filter = new MarkerFilter(validMarkers);
  }

  /** Everything the model has written so far, untouched. */
  get rawText(): string {
    return this.raw;
  }

  /**
   * Whether the reply is a refusal (it began with the sentinel, or with the mandated sentence after nothing cited): the caller
   * stops the model. The name is kept from when the sentinel was the only refusal.
   */
  get startedWithSentinel(): boolean {
    return this.refused;
  }

  push(chunk: string): PushResult {
    if (this.blockedVerdict !== null) return { emit: '', blocked: this.blockedVerdict };
    this.raw += chunk;
    if (this.refused) return { emit: '', blocked: null };
    const verdict = this.guard.check(this.raw);
    if (verdict !== null) {
      this.blockedVerdict = verdict;
      return { emit: '', blocked: verdict };
    }
    if (this.phase === 'settled') return { emit: this.filter.push(chunk), blocked: null };
    return { emit: this.advance(false) ?? '', blocked: null };
  }

  /** The stream ended: releases anything still held back (unless what was held is a refusal). */
  end(): string {
    if (this.refused) return '';
    const released = this.phase === 'settled' ? '' : this.advance(true);
    return released === null ? '' : released + this.filter.flush();
  }

  /**
   * Releases what can no longer be part of a leading refusal (see sentinel.ts `scanReply`): the text to pass on, or null when
   * the reply turned out to be a refusal.
   */
  private advance(final: boolean): string | null {
    const scan = scanReply(this.raw, { final, sentinel: this.phase === 'sentinel' });
    if (scan.refusal !== null) {
      // The reply is the refusal: nothing more of it is shown (the caller stops the model and writes its own sentence in
      // the language of the question). A flourish released before the sentence stays shown; `done` replaces it.
      this.refused = true;
      return null;
    }
    if (this.phase === 'sentinel' && !scan.sentinelOpen) this.phase = 'scan';
    if (scan.settled) this.phase = 'settled';
    const upTo = final || scan.settled ? this.raw.length : scan.hold;
    if (upTo <= this.released) return '';
    const text = this.raw.slice(this.released, upTo);
    this.released = upTo;
    return this.filter.push(text);
  }
}

export interface FinalReply {
  /** The cleaned text: valid markers only, no uncited line, tidy spacing. Empty for a refusal. */
  text: string;
  /** The model refused: the reply starts with the sentinel, or with the mandated sentence (sentinel.ts `scanReply`). */
  notFound: boolean;
  /** Valid markers of the final text in order of first appearance, e.g. `['S2', 'S1']`. */
  cited: string[];
  /** How many lines or sentences were dropped because they carried no citation (0 when the reply cited nothing at all). */
  droppedUncitedLines: number;
}

const markersOf = (text: string): string[] => {
  const cited: string[] = [];
  for (const match of text.matchAll(/\[(S\d{1,3})\]/gu)) {
    const marker = match[1] ?? '';
    if (!cited.includes(marker)) cited.push(marker);
  }
  return cited;
};

/** Words whose full stop does not end a sentence ("Dr. Nabil Al-Khatib", "approx. 300"). */
const ABBREVIATIONS = new Set([
  'dr', 'mr', 'mrs', 'ms', 'prof', 'st', 'sr', 'jr', 'vs', 'etc', 'no', 'nos', 'fig', 'inc', 'ltd', 'co', 'vol', 'pp', 'p',
  'approx', 'al', 'cf', 'ed', 'eds', 'ca', 'dept', 'univ', 'est', 'ave', 'mt', 'ft',
]); // prettier-ignore

/** The sentences of a line (a boundary is a full stop, "!" or "?" followed by a capital, a digit or an opening mark). */
export function splitSentences(line: string): string[] {
  const parts: string[] = [];
  let start = 0;
  const boundary = /([.!?؟。])(\s+)(?=[\p{Lu}\p{Lo}\p{N}[("“'«])/gu;
  for (const match of line.matchAll(boundary)) {
    const end = match.index + 1;
    if (match[1] === '.') {
      const word = /([\p{L}]+)$/u.exec(line.slice(start, match.index))?.[1]?.toLowerCase() ?? '';
      if (word !== '' && (word.length <= 1 || ABBREVIATIONS.has(word))) continue;
    }
    parts.push(line.slice(start, end));
    start = match.index + match[0].length;
  }
  parts.push(line.slice(start));
  return parts;
}

/** At most this many statements about the document's silence stay uncited in one reply (and only after something cited). */
const MAX_SILENCE_STATEMENTS = 2;

/**
 * Drops what cites nothing, when the reply cites something: the model was told to cite every sentence, so a line or a sentence
 * with no marker is not the document speaking (an "Audit: ..." or "Notice: ..." line a page talked it into, a flourish such as
 * "Ah, seeker!", a claim the model made up). Two exceptions:
 *  - the heading of a list: a line ending with a colon right before cited lines, at most 8 words, holding no address, number,
 *    second person, order or second sentence (silence.ts `isHarmlessHeading`, review N3-1);
 *  - a statement about the document's SILENCE on the visitor's question ("the document does not state whether ..."), which
 *    has nothing to cite and is the half of a partial answer that names the missing qualifier: the WHOLE sentence must match
 *    silence.ts's template, and what it says is missing must be the question's own words (`question`: the question as typed
 *    and its successful rewrite; without it only a gap that names nothing stays); at most two per reply, after something cited.
 * A reply that cites nothing at all is left alone: it is shown, and not grounded. A lead fragment inside a cited sentence
 * ("PWNED The keeper was Morwenna [S1].") is not a sentence of its own: the drop works on sentences, not on words. The price: a
 * model that cites once for a whole paragraph loses the uncited sentences of it; the prompt asks for a marker on every sentence
 * and the live model gives one.
 */
export function dropUncitedLines(
  text: string,
  question: QuestionContext | null = null,
): { text: string; dropped: number } {
  if (markersOf(text).length === 0) return { text, dropped: 0 };
  const lines = text.split('\n');
  const kept: string[] = [];
  let dropped = 0;
  let citedSoFar = false;
  let silences = 0;
  /** A sentence without a marker may stay only as a statement of silence, and only after something cited. */
  const staysUncited = (sentence: string): boolean => {
    if (!citedSoFar || silences >= MAX_SILENCE_STATEMENTS || !isSilenceStatement(sentence, question))
      return false;
    silences += 1;
    return true;
  };
  lines.forEach((line, index) => {
    if (line.trim() === '') {
      kept.push(line);
      return;
    }
    const hasMarker = /\[S\d{1,3}\]/u.test(line);
    if (!hasMarker) {
      const next = lines.slice(index + 1).find((candidate) => candidate.trim() !== '');
      if (
        next !== undefined &&
        /\[S\d{1,3}\]/u.test(next) &&
        isHarmlessHeading(line, lines.slice(index + 1).join('\n'))
      ) {
        kept.push(line);
        return;
      }
    }
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+/u.exec(line)?.[0] ?? '';
    // a marker written after its full stop ("... in 1847. [S2]") belongs to the sentence before it: put it back in front of the stop
    const moved = line
      .slice(bullet.length)
      .replace(
        /([.!?؟。])\s*((?:\[S\d{1,3}\]\s*)+)/gu,
        (_all, stop: string, markers: string) => ` ${markers.trim()}${stop} `,
      );
    const merged = splitSentences(moved);
    const survivors = merged.filter((sentence) => {
      if (/\[S\d{1,3}\]/u.test(sentence)) {
        citedSoFar = true;
        return true;
      }
      return staysUncited(sentence);
    });
    dropped += merged.length - survivors.length;
    if (survivors.length === 0) return;
    // (a line that lost nothing is kept as it was written)
    kept.push(
      survivors.length === merged.length
        ? line
        : `${bullet}${survivors.map((sentence) => sentence.trim()).join(' ')}`,
    );
  });
  return { text: kept.join('\n'), dropped };
}

const tidy = (text: string): string =>
  text
    .replace(/[ \t]+([.,;:!?،؛؟])/gu, '$1')
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();

/**
 * Applies the reply rules to the finished text. `question`: the words of the visitor's question (as typed, and its successful
 * rewrite: silence.ts `questionContext`), which a statement of the document's silence must be about.
 */
export function finalizeReply(
  raw: string,
  validMarkers: ReadonlySet<string>,
  question: QuestionContext | null = null,
): FinalReply {
  if (isRefusalReply(raw)) return { text: '', notFound: true, cited: [], droppedUncitedLines: 0 };
  const dropped = dropUncitedLines(tidy(filterMarkers(raw, validMarkers)), question);
  const text = tidy(dropped.text);
  return { text, notFound: false, cited: markersOf(text), droppedUncitedLines: dropped.dropped };
}
