/** The longest display name kept, in characters. */
export const DISPLAY_FILENAME_MAX_CHARS = 120;
const FALLBACK_NAME = 'document.pdf';

// Control characters, zero-width and bidi marks, bidi embedding/override/isolate controls (U+202A-U+202E,
// U+2066-U+2069) and the "tag" characters (U+E0000-U+E007F): a file name is shown back to people, and these
// can reorder or hide what they read. ZWJ/ZWNJ are kept (they are spelling in Persian and Urdu names).
const UNSAFE =
  /[\p{Cc}\u{061C}\u{200B}\u{200E}\u{200F}\u{2028}\u{2029}\u{202A}-\u{202E}\u{2060}\u{2066}-\u{2069}\u{FEFF}\u{E0000}-\u{E007F}]/gu;

/**
 * The name an uploaded file is displayed under: only the last path segment, without control, bidi-control and
 * tag characters, spaces collapsed, at most 120 characters (the extension survives truncation). The stored file
 * never has this name (it is a server-generated UUID): this is for display only.
 */
export function sanitizeDisplayFilename(name: string): string {
  const base = name.split(/[\\/]/u).pop() ?? '';
  const cleaned = base.normalize('NFC').replace(UNSAFE, '').replace(/\s+/gu, ' ').trim();
  if (cleaned === '' || /^\.+$/u.test(cleaned)) return FALLBACK_NAME;
  const characters = Array.from(cleaned);
  if (characters.length <= DISPLAY_FILENAME_MAX_CHARS) return cleaned;
  const extension = /\.[\p{L}\p{N}]{1,8}$/u.exec(cleaned)?.[0] ?? '';
  const stem = characters.slice(0, DISPLAY_FILENAME_MAX_CHARS - Array.from(extension).length).join('');
  return `${stem}${extension}`;
}
