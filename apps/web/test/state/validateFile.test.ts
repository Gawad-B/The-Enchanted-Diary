import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FALLBACK_MAX_UPLOAD_BYTES,
  MAGIC_WINDOW_BYTES,
  displayName,
  hasPdfHeader,
  validateManuscript,
} from '../../src/state/validateFile';
import { flavourOf } from '../../src/api/errorDetail';

const FIXTURES = resolve(__dirname, '../../../../fixtures');
const LIMITS = { maxBytes: 20 * 1024 * 1024 };

function fileOf(parts: BlobPart[], name: string, type = 'application/pdf'): File {
  return new File(parts, name, { type });
}

function fixture(name: string): File {
  return fileOf([new Uint8Array(readFileSync(resolve(FIXTURES, name)))], name);
}

const pdfBytes = (prefix = 0): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(prefix + 8);
  bytes.fill(0x20, 0, prefix);
  bytes.set([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37], prefix);
  return bytes;
};

describe('validateManuscript (client-side, before a byte is sent)', () => {
  it.each(['text-en.pdf', 'arabic.pdf', 'multi-page-long.pdf'])(
    'accepts the real fixture %s',
    async (name) => {
      expect(await validateManuscript(fixture(name), LIMITS)).toEqual({ ok: true });
    },
  );

  it("rejects a .txt file by its name, in the diary's terms (FILE_NOT_PDF)", async () => {
    const verdict = await validateManuscript(fileOf(['hello'], 'notes.txt', 'text/plain'), LIMITS);
    expect(verdict).toMatchObject({ ok: false, error: { code: 'FILE_NOT_PDF' } });
  });

  it('rejects a text file renamed .pdf: the first kilobyte does not hold %PDF-', async () => {
    const verdict = await validateManuscript(
      fileOf(['This is not a PDF, only a renamed text file.'], 'fake.pdf'),
      LIMITS,
    );
    expect(verdict).toMatchObject({ ok: false, error: { code: 'FILE_NOT_PDF' } });
    expect(verdict.ok ? '' : verdict.error.detail).toContain('%PDF-');
    // and the real fixture under a wrong extension is refused by name
    const wrongName = fileOf(
      [new Uint8Array(readFileSync(resolve(FIXTURES, 'text-en.pdf')))],
      'text-en.docx',
    );
    expect(await validateManuscript(wrongName, LIMITS)).toMatchObject({
      ok: false,
      error: { code: 'FILE_NOT_PDF' },
    });
  });

  it("rejects the repository's own not-a-pdf fixture (a .pdf name over other bytes)", async () => {
    expect(await validateManuscript(fixture('not-a-pdf.pdf'), LIMITS)).toMatchObject({
      ok: false,
      error: { code: 'FILE_NOT_PDF' },
    });
  });

  it("rejects a type that is not a PDF's, but accepts the empty and the generic type some browsers send", async () => {
    expect(await validateManuscript(fileOf([pdfBytes()], 'a.pdf', 'image/png'), LIMITS)).toMatchObject({
      ok: false,
      error: { code: 'FILE_NOT_PDF', detail: 'type: image/png' },
    });
    expect(await validateManuscript(fileOf([pdfBytes()], 'a.pdf', ''), LIMITS)).toEqual({ ok: true });
    expect(
      await validateManuscript(fileOf([pdfBytes()], 'a.pdf', 'application/octet-stream'), LIMITS),
    ).toEqual({ ok: true });
  });

  it('rejects an empty file (FILE_MISSING)', async () => {
    expect(await validateManuscript(fileOf([], 'empty.pdf'), LIMITS)).toMatchObject({
      ok: false,
      error: { code: 'FILE_MISSING' },
    });
  });

  it('rejects a file over the size the server accepts (FILE_TOO_LARGE), exactly at the limit is fine', async () => {
    const limit = { maxBytes: 1000 };
    const big = new Uint8Array(1001);
    big.set(pdfBytes());
    expect(await validateManuscript(fileOf([big], 'big.pdf'), limit)).toMatchObject({
      ok: false,
      error: { code: 'FILE_TOO_LARGE' },
    });
    const exact = new Uint8Array(1000);
    exact.set(pdfBytes());
    expect(await validateManuscript(fileOf([exact], 'exact.pdf'), limit)).toEqual({ ok: true });
  });

  it('checks the first kilobyte only: a mark just inside is found, one past it is not', async () => {
    expect(await hasPdfHeader(new Blob([pdfBytes(MAGIC_WINDOW_BYTES - 5)]))).toBe(true);
    expect(await hasPdfHeader(new Blob([pdfBytes(MAGIC_WINDOW_BYTES - 4)]))).toBe(false);
  });

  it('uppercase extensions and names with bidi text are fine', async () => {
    expect(await validateManuscript(fileOf([pdfBytes()], 'تقرير.PDF'), LIMITS)).toEqual({ ok: true });
  });
});

describe('the reason is named (the line is chosen by it, not by the code alone)', () => {
  const verdict = async (file: File) => {
    const result = await validateManuscript(file, LIMITS);
    if (result.ok) throw new Error('expected a refusal');
    return result.error;
  };

  it('a wrong name, a wrong type and wrong first bytes are three different flavours of FILE_NOT_PDF', async () => {
    expect(flavourOf(await verdict(fileOf(['x'], 'notes.txt', 'text/plain')))).toBe('notPdfName');
    expect(flavourOf(await verdict(fileOf([pdfBytes()], 'a.pdf', 'text/plain')))).toBe('notPdfType');
    expect(flavourOf(await verdict(fileOf(['hello'], 'a.pdf')))).toBe('notPdfHeader');
  });
});

describe('m-16: until the server has said its limit, the most any mode takes is allowed (the ticket re-checks)', () => {
  it('the fallback is 50 MB, so a 30 MB file is not turned away by a config that did not answer', () => {
    expect(FALLBACK_MAX_UPLOAD_BYTES).toBe(50 * 1024 * 1024);
  });
});

describe('displayName (M19 / section L: names are shown only after sanitising)', () => {
  it('strips the characters that reorder or hide text: a right-to-left override cannot make "exe" read as "pdf"', () => {
    expect(displayName('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
    expect(displayName('a\u2066b\u2069c')).toBe('abc');
    expect(displayName('x\u200Ey\u200Fz\u061Cw')).toBe('xyzw');
  });

  it('strips control and tag characters and a zero-width space, and keeps Arabic and ordinary names as they are', () => {
    expect(displayName('a\u0000b\u001Fc\u007Fd\u0085e')).toBe('abcde');
    expect(displayName('a\u{E0041}b\u200Bc\uFEFFd')).toBe('abcd');
    expect(displayName('تقرير 2026.pdf')).toBe('تقرير 2026.pdf');
    expect(displayName('Manuscript (final).pdf')).toBe('Manuscript (final).pdf');
  });

  it('shortens an endless name, and the technical line names the sanitised file', async () => {
    expect(Array.from(displayName('x'.repeat(500))).length).toBe(118);
    const result = await validateManuscript(fileOf(['x'], 'bad\u202Ename.txt', 'text/plain'), LIMITS);
    expect(result.ok ? '' : result.error.detail).toBe('name: badname.txt');
  });
});
