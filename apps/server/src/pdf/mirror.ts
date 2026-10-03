/*
 * Paired punctuation in right-to-left text. A PDF stores the glyph that was DRAWN: in an Arabic sentence the opening
 * bracket is drawn as the mirror image, so its Unicode value in the file (and in pdf.js's output) is the closing one.
 * pdf.js puts the items of an RTL run back in logical order (like UAX #9 rule L2) but does not undo the mirroring
 * (the inverse of rule L4), so "(وهو أمين المكتبة)" would come out as ")وهو أمين المكتبة(". Characters in
 * right-to-left runs are therefore swapped with their mirror partner.
 */

/** Mirror pairs from BidiMirroring.txt (code points): the brackets, quotation marks and relations that occur in text. */
const PAIRS: [number, number][] = [
  [0x0028, 0x0029],
  [0x003c, 0x003e],
  [0x005b, 0x005d],
  [0x007b, 0x007d],
  [0x00ab, 0x00bb],
  [0x2039, 0x203a],
  [0x2045, 0x2046],
  [0x207d, 0x207e],
  [0x208d, 0x208e],
  [0x2208, 0x220b],
  [0x2209, 0x220c],
  [0x220a, 0x220d],
  [0x2264, 0x2265],
  [0x2266, 0x2267],
  [0x226a, 0x226b],
  [0x2282, 0x2283],
  [0x2286, 0x2287],
  [0x2308, 0x2309],
  [0x230a, 0x230b],
  [0x27e6, 0x27e7],
  [0x27e8, 0x27e9],
  [0x27ea, 0x27eb],
  [0x2983, 0x2984],
  [0x2985, 0x2986],
  [0x3008, 0x3009],
  [0x300a, 0x300b],
  [0x300c, 0x300d],
  [0x300e, 0x300f],
  [0x3010, 0x3011],
  [0x3014, 0x3015],
  [0x3016, 0x3017],
  [0x3018, 0x3019],
  [0x301a, 0x301b],
  [0xff08, 0xff09],
  [0xff1c, 0xff1e],
  [0xff3b, 0xff3d],
  [0xff5b, 0xff5d],
];

const MIRROR = new Map<string, string>();
for (const [a, b] of PAIRS) {
  MIRROR.set(String.fromCodePoint(a), String.fromCodePoint(b));
  MIRROR.set(String.fromCodePoint(b), String.fromCodePoint(a));
}
const escapeInClass = (char: string): string => char.replace(/[\\\]^-]/gu, '\\$&');
const MIRRORED = new RegExp(`[${[...MIRROR.keys()].map(escapeInClass).join('')}]`, 'gu');

/** `text` with every mirrored character replaced by its partner: for text that came out of a right-to-left run. */
export function mirrorPairedPunctuation(text: string): string {
  return text.replace(MIRRORED, (char) => MIRROR.get(char) ?? char);
}
