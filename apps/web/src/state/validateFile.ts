import type { UiError } from '../api/client';
import { CLIENT_REASON } from '../api/errorDetail';

/**
 * Used until the server's limit is known (`/api/config` did not answer): the most any mode of the server takes (50 MB direct;
 * 20 MB in Blob mode by default). A file between the two is turned away by the ticket, which knows the real limit, so a slow
 * or failed config never refuses a file the server would have taken.
 */
export const FALLBACK_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Bidirectional controls and invisible characters: they can make a name read as another (an `exe` that looks like `pdf`). */
/* eslint-disable no-control-regex -- the point of this expression is to find control characters */
const HIDDEN_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\u{e0000}-\u{e007f}]/gu;
/* eslint-enable no-control-regex */

/** A local file's name as it may be shown: without the characters that reorder or hide text, and not endless. */
export function displayName(name: string): string {
  const clean = name.replace(HIDDEN_CHARACTERS, '');
  const letters = Array.from(clean);
  return letters.length > 120 ? `${letters.slice(0, 117).join('')}…` : clean;
}

/** The server looks for `%PDF-` in the first kilobyte (some producers put a few bytes of junk before it). */
export const MAGIC_WINDOW_BYTES = 1024;

/** MIME types a PDF may come with (some browsers and operating systems send none, or the generic type). */
const ACCEPTED_TYPES = new Set(['application/pdf', 'application/x-pdf', 'application/octet-stream', '']);

export interface ValidationLimits {
  maxBytes: number;
}

export type Validation = { ok: true } | { ok: false; error: UiError };

function reject(code: UiError['code'], message: string, detail?: string): Validation {
  return { ok: false, error: { code, message, ...(detail === undefined ? {} : { detail }) } };
}

/** Reads a blob's bytes (jsdom and older browsers have no `Blob.arrayBuffer`). */
async function readBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject: (reason: unknown) => void) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(new Uint8Array(reader.result as ArrayBuffer));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('The file could not be read'));
    };
    reader.readAsArrayBuffer(blob);
  });
}

/** Whether `%PDF-` appears in the first kilobyte of a file. */
export async function hasPdfHeader(file: Blob): Promise<boolean> {
  const head = await readBytes(file.slice(0, MAGIC_WINDOW_BYTES));
  const magic = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
  for (let start = 0; start + magic.length <= head.length; start += 1) {
    if (magic.every((byte, offset) => head[start + offset] === byte)) return true;
  }
  return false;
}

/**
 * The checks the browser can make before a single byte is sent, in the order of what the reader most likely got wrong:
 * the name ends in .pdf, the type is a PDF's, the file is not empty, it is not larger than the server accepts, and its first
 * kilobyte holds the `%PDF-` mark (a renamed text file is caught here, not after an upload). The server checks all of it
 * again; these exist to say so at once, in the diary's voice, and to spare a pointless upload. The page count and the
 * structure are the server's to judge.
 */
export async function validateManuscript(file: File, limits: ValidationLimits): Promise<Validation> {
  if (!/\.pdf$/iu.test(file.name)) {
    return reject(
      'FILE_NOT_PDF',
      'The file name does not end in .pdf.',
      `${CLIENT_REASON.name}${displayName(file.name).slice(-40)}`,
    );
  }
  if (!ACCEPTED_TYPES.has(file.type.toLowerCase())) {
    return reject(
      'FILE_NOT_PDF',
      'The file is not a PDF.',
      `${CLIENT_REASON.type}${displayName(file.type).slice(0, 60)}`,
    );
  }
  if (file.size === 0) return reject('FILE_MISSING', 'The file is empty.');
  if (file.size > limits.maxBytes) {
    return reject(
      'FILE_TOO_LARGE',
      'The file is larger than the maximum upload size.',
      `${String(file.size)} bytes; the limit is ${String(limits.maxBytes)}`,
    );
  }
  let marked: boolean;
  try {
    marked = await hasPdfHeader(file);
  } catch {
    return reject('FILE_MISSING', 'The file could not be read.');
  }
  if (!marked)
    return reject(
      'FILE_NOT_PDF',
      'The file does not begin like a PDF.',
      `${CLIENT_REASON.header} in the first kilobyte`,
    );
  return { ok: true };
}
