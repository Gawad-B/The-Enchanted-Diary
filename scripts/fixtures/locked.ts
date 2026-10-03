import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

/*
 * A PDF that is encrypted with an OWNER password only: no password is needed to open and read it (readers decrypt it with
 * the empty user password), the owner password only guards its permissions (printing, copying, editing). Publishers send
 * scans like this all the time. pdf.js opens it; pdf-lib, told to ignore the encryption, copies its pages with their
 * streams still encrypted into a file that has no key, which reads as blank pages.
 */

const run = promisify(execFile);

/** `source` encrypted by Ghostscript with an owner password and no user password (128-bit RC4, copying not permitted). */
export async function ownerLocked(source: Uint8Array, scratchDir: string): Promise<Uint8Array> {
  await mkdir(scratchDir, { recursive: true });
  const input = path.join(scratchDir, 'lock-in.pdf');
  const output = path.join(scratchDir, 'lock-out.pdf');
  await writeFile(input, source);
  try {
    await run('gs', [
      '-q',
      '-dNOPAUSE',
      '-dBATCH',
      '-sDEVICE=pdfwrite',
      '-sOwnerPassword=owner-secret',
      '-dEncryptionR=3',
      '-dKeyLength=128',
      '-dPermissions=-3904', // print and nothing else: no copying, no editing
      `-sOutputFile=${output}`,
      input,
    ]);
    return new Uint8Array(await readFile(output));
  } finally {
    await rm(input, { force: true });
    await rm(output, { force: true });
  }
}
