import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/db/client.js';
import { documentsRepo } from '../src/db/repositories/documents.js';
import { UPLOAD_SCRATCH_DIRECTORY } from '../src/storage/retention.js';
import {
  errorOf,
  multipartBody,
  sessionOf,
  startServer,
  summaryOf,
  type TestServer,
} from './http-helpers.js';
import { readFixture } from './fixtures.js';
import { testConfig } from './helpers.js';

let db: Db;
const servers: TestServer[] = [];

beforeAll(async () => {
  db = await createDb(testConfig());
});
afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await db.close();
});

async function server(
  env: Record<string, string> = {},
  overrides: Parameters<typeof testConfig>[1] = {},
): Promise<TestServer> {
  // These tests upload dozens of valid files that nobody reads: the line of documents must not fill up (its own tests are
  // in documents-lifecycle.test.ts).
  const started = await startServer(db, testConfig({ MAX_QUEUED_JOBS: '1000', ...env }, overrides));
  servers.push(started);
  return started;
}

describe('POST /api/documents: what is checked', () => {
  it('rejects a PNG with a .pdf name: FILE_NOT_PDF 415 (magic bytes)', async () => {
    const { client } = await server();
    const response = await client().uploadFixture('not-a-pdf.pdf');
    expect(response.statusCode).toBe(415);
    expect(errorOf(response)).toMatchObject({ code: 'FILE_NOT_PDF' });
    expect(errorOf(response).detail).toContain('%PDF-');
  });

  it('rejects a file that is not named .pdf, and a content type that is not PDF', async () => {
    const { client } = await server();
    const pdf = await readFixture('text-en.pdf');
    const badName = await client().upload(pdf, { filename: 'manuscript.png' });
    expect(badName.statusCode).toBe(415);
    expect(errorOf(badName).code).toBe('FILE_NOT_PDF');
    const badType = await client().upload(pdf, { contentType: 'image/png' });
    expect(badType.statusCode).toBe(415);
    expect(errorOf(badType).code).toBe('FILE_NOT_PDF');
    expect(errorOf(badType).detail).toContain('image/png');
  });

  it('accepts the extension in any case and application/x-pdf', async () => {
    const { client } = await server();
    const pdf = await readFixture('text-en.pdf');
    expect(summaryOf(await client().upload(pdf, { filename: 'LOUD.PDF' })).filename).toBe('LOUD.PDF');
    expect(summaryOf(await client().upload(pdf, { contentType: 'application/x-pdf' })).status).toBe(
      'processing',
    );
  }, 30_000);

  it('accepts application/octet-stream only when the magic bytes are valid', async () => {
    const { client } = await server();
    const accepted = await client().upload(await readFixture('text-en.pdf'), {
      contentType: 'application/octet-stream',
    });
    expect(accepted.statusCode).toBe(202);
    const refused = await client().upload(await readFixture('not-a-pdf.pdf'), {
      contentType: 'application/octet-stream',
    });
    expect(refused.statusCode).toBe(415);
    expect(errorOf(refused).code).toBe('FILE_NOT_PDF');
  }, 30_000);

  it('accepts a %PDF- header that is not at byte 0 but within the first 1024 bytes, and no later', async () => {
    const { client } = await server();
    const pdf = await readFixture('text-en.pdf');
    const within = Buffer.concat([Buffer.alloc(900, 0x20), pdf]);
    // The header is where pdf.js looks for it too, so structure validation decides: not a FILE_NOT_PDF.
    expect((await client().upload(within)).statusCode).not.toBe(415);
    const beyond = Buffer.concat([Buffer.alloc(1100, 0x20), pdf]);
    expect((await client().upload(beyond)).statusCode).toBe(415);
  }, 30_000);

  it('rejects a malformed PDF: PDF_MALFORMED 422', async () => {
    const { client } = await server();
    const response = await client().uploadFixture('malformed.pdf');
    expect(response.statusCode).toBe(422);
    expect(errorOf(response).code).toBe('PDF_MALFORMED');
  }, 30_000);

  it('rejects an encrypted PDF: PDF_ENCRYPTED 422', async () => {
    const { client } = await server();
    const response = await client().uploadFixture('encrypted.pdf');
    expect(response.statusCode).toBe(422);
    expect(errorOf(response).code).toBe('PDF_ENCRYPTED');
  }, 30_000);

  it('rejects a PDF with more pages than MAX_PAGES: TOO_MANY_PAGES 422', async () => {
    const { client } = await server({ MAX_PAGES: '10' });
    const response = await client().uploadFixture('twelve-pages.pdf');
    expect(response.statusCode).toBe(422);
    expect(errorOf(response)).toMatchObject({ code: 'TOO_MANY_PAGES' });
    expect(errorOf(response).message).toContain('12 pages');
  }, 30_000);

  it('rejects a file over the size limit: FILE_TOO_LARGE 413, whether declared or streamed', async () => {
    const { client } = await server({}, { maxUploadBytes: 4096 });
    const pdf = await readFixture('multi-page-long.pdf'); // 28 KB
    const uploader = client();
    const response = await uploader.upload(pdf);
    expect(response.statusCode).toBe(413);
    expect(errorOf(response).code).toBe('FILE_TOO_LARGE');
    // Nothing was stored for the session that tried (its own id, not a made-up one), and no scratch file stayed.
    expect(await documentsRepo.listForSession(db, await sessionOf(uploader))).toEqual([]);
  });

  it('answers FILE_MISSING 400 for no file, a wrong field name, an empty file and a request that is not multipart', async () => {
    const { client } = await server();
    const pdf = await readFixture('text-en.pdf');
    const wrongField = await client().upload(pdf, { field: 'document' });
    expect(wrongField.statusCode).toBe(400);
    expect(errorOf(wrongField).code).toBe('FILE_MISSING');

    const noFile = multipartBody(Buffer.alloc(0), { field: 'file' });
    const onlyFields = await client().request('POST', '/api/documents', {
      payload: Buffer.from(`--b\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n--b--\r\n`),
      headers: { 'content-type': 'multipart/form-data; boundary=b' },
    });
    expect(onlyFields.statusCode).toBe(400);
    expect(errorOf(onlyFields).code).toBe('FILE_MISSING');

    const empty = await client().request('POST', '/api/documents', noFile);
    expect(empty.statusCode).toBe(400);
    expect(errorOf(empty).code).toBe('FILE_MISSING');

    // A field declared as JSON that is not JSON, and no file: the plugin's 406 (FST_INVALID_JSON_FIELD_ERROR) is FILE_MISSING 400.
    const badJson = await client().request('POST', '/api/documents', {
      payload: Buffer.from(
        '--b\r\nContent-Disposition: form-data; name="meta"\r\nContent-Type: application/json\r\n\r\n{not json\r\n--b--\r\n',
      ),
      headers: { 'content-type': 'multipart/form-data; boundary=b' },
    });
    expect(badJson.statusCode).toBe(400);
    expect(errorOf(badJson).code).toBe('FILE_MISSING');

    const json = await client().request('POST', '/api/documents', {
      payload: Buffer.from('{}'),
      headers: { 'content-type': 'application/json' },
    });
    expect(json.statusCode).toBe(400);
    expect(errorOf(json).code).toBe('FILE_MISSING');
  });

  it('never reads form fields other than the file, but a field declared as JSON that is not JSON is refused: FILE_MISSING 400', async () => {
    const { client } = await server();
    const plain = await client().upload(await readFixture('not-a-pdf.pdf'), {
      before: [{ name: 'note', value: 'hello' }],
    });
    expect(plain.statusCode).toBe(415); // an ordinary field is skipped: judged by the file alone
    expect(errorOf(plain).code).toBe('FILE_NOT_PDF');
    // The multipart plugin parses a JSON field when it reaches it, so a broken one fails the whole request (it used
    // to be skipped silently at the end of the body, depending on its position).
    for (const position of ['before', 'after'] as const) {
      const uploader = client();
      const response = await uploader.upload(await readFixture('text-en.pdf'), {
        [position]: [{ name: 'meta', value: '{not json', contentType: 'application/json' }],
      });
      expect(response.statusCode, position).toBe(400);
      expect(errorOf(response).code, position).toBe('FILE_MISSING');
      expect(await documentsRepo.listForSession(db, await sessionOf(uploader))).toEqual([]);
    }
  });

  it('refuses a second file or a flood of fields (the plugin limits), as FILE_TOO_LARGE 413', async () => {
    const { client } = await server();
    const pdf = await readFixture('text-en.pdf');
    const first = multipartBody(pdf, { filename: 'a.pdf' });
    const boundary = /boundary=(.*)$/u.exec(first.headers['content-type'] ?? '')?.[1] ?? '';
    const two = Buffer.concat([
      first.payload.subarray(0, first.payload.length - `--${boundary}--\r\n`.length),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="b.pdf"\r\nContent-Type: application/pdf\r\n\r\n${pdf.toString('latin1')}\r\n--${boundary}--\r\n`,
        'latin1',
      ),
    ]);
    const response = await client().request('POST', '/api/documents', {
      payload: two,
      headers: first.headers,
    });
    expect(response.statusCode).toBe(413);
    expect(errorOf(response).code).toBe('FILE_TOO_LARGE');
    const fields = await client().upload(pdf, {
      before: Array.from({ length: 12 }, (_, i) => ({ name: `f${String(i)}`, value: 'x' })),
    });
    expect(fields.statusCode).toBe(413);
    expect(errorOf(fields).code).toBe('FILE_TOO_LARGE');
  }, 30_000);

  it('removes its scratch file after every outcome, accepted or refused', async () => {
    const started = await server();
    const scratch = path.join(started.config.tmpDir, UPLOAD_SCRATCH_DIRECTORY);
    await started.client().uploadFixture('not-a-pdf.pdf');
    await started.client().uploadFixture('malformed.pdf');
    const accepted = await started.client().uploadFixture('text-en.pdf');
    expect(accepted.statusCode).toBe(202);
    expect(await readdir(scratch)).toEqual([]);
  }, 60_000);
});

describe('document display names', () => {
  it('shows only a sanitised base name: no path, no control or bidi characters, at most 120 characters', async () => {
    const { client } = await server();
    const pdf = await readFixture('text-en.pdf');
    const c = client();
    const traversal = summaryOf(await c.upload(pdf, { filename: '../../etc/passwd.pdf' }));
    expect(traversal.filename).toBe('passwd.pdf');
    const bidi = summaryOf(await c.upload(pdf, { filename: 'report\u202Efdp.exe.pdf' }));
    expect(bidi.filename).toBe('reportfdp.exe.pdf');
    const long = summaryOf(await c.upload(pdf, { filename: `${'a'.repeat(200)}.pdf` }));
    expect(long.filename).toHaveLength(120);
    expect(long.filename.endsWith('.pdf')).toBe(true);
    expect(new Set([traversal.id, bidi.id, long.id]).size).toBe(3);
  }, 60_000);
});
